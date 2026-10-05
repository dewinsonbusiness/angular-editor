//! Control de versiones con el `git` instalado en el sistema (sin libgit2, para no pesar).

use serde::Serialize;
use std::process::{Command, Stdio};

fn git(cwd: &str, args: &[&str]) -> Result<std::process::Output, String> {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0") // nunca quedarse esperando una contraseña
        .env("GIT_OPTIONAL_LOCKS", "0") // `status` no debe bloquear a otros procesos git
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.output()
        .map_err(|e| format!("no se pudo ejecutar git: {e}"))
}

/// Ejecuta git y devuelve stdout; si falla, el error lleva stderr.
fn git_ok(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = git(cwd, args)?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        } else {
            err
        })
    }
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct FileStatus {
    /// Ruta relativa a la raíz del repositorio, con "/".
    path: String,
    /// Estado en el índice (preparado) y en el árbol de trabajo: letras de `git status` (M, A, D, R, ?, U…).
    index: char,
    worktree: char,
    /// Ruta anterior si fue renombrado.
    orig: Option<String>,
}

#[derive(Serialize)]
pub struct RepoStatus {
    /// Raíz del repositorio (puede ser una carpeta superior a la abierta).
    root: String,
    branch: Option<String>,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    files: Vec<FileStatus>,
}

/// Estado del repositorio que contiene `cwd`, o `None` si no es un repositorio git.
#[tauri::command]
pub async fn git_status(cwd: String) -> Result<Option<RepoStatus>, String> {
    blocking(move || {
        let Ok(top) = git_ok(&cwd, &["rev-parse", "--show-toplevel"]) else {
            return Ok(None);
        };
        let root = top.trim().replace('/', "\\");
        let raw = git_ok(
            &root,
            &[
                "status",
                "--porcelain=v2",
                "--branch",
                "-z",
                "--untracked-files=all",
            ],
        )?;
        Ok(Some(parse_status(root, &raw)))
    })
    .await
}

/// Interpreta la salida de `git status --porcelain=v2 --branch -z`.
fn parse_status(root: String, raw: &str) -> RepoStatus {
    let mut st = RepoStatus {
        root,
        branch: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        files: vec![],
    };
    let mut parts = raw.split('\0').filter(|s| !s.is_empty());
    while let Some(rec) = parts.next() {
        if let Some(h) = rec.strip_prefix("# branch.head ") {
            st.branch = (h != "(detached)").then(|| h.to_string());
        } else if let Some(u) = rec.strip_prefix("# branch.upstream ") {
            st.upstream = Some(u.to_string());
        } else if let Some(ab) = rec.strip_prefix("# branch.ab ") {
            let mut it = ab.split(' ');
            st.ahead = it
                .next()
                .and_then(|a| a.trim_start_matches('+').parse().ok())
                .unwrap_or(0);
            st.behind = it
                .next()
                .and_then(|b| b.trim_start_matches('-').parse().ok())
                .unwrap_or(0);
        } else if let Some(p) = rec.strip_prefix("? ") {
            st.files.push(FileStatus {
                path: p.into(),
                index: '?',
                worktree: '?',
                orig: None,
            });
        } else if rec.starts_with("1 ") || rec.starts_with("u ") {
            // "1 XY sub mH mI mW hH hI ruta" / "u XY sub m1 m2 m3 mW h1 h2 h3 ruta"
            let fields = if rec.starts_with('1') { 8 } else { 10 };
            let mut it = rec.splitn(fields + 1, ' ');
            let xy: Vec<char> = it.nth(1).unwrap_or("..").chars().collect();
            let path = it.nth(fields - 2).unwrap_or("").to_string();
            let (index, worktree) = if rec.starts_with('u') {
                ('U', 'U')
            } else {
                (xy[0], xy[1])
            };
            st.files.push(FileStatus {
                path,
                index,
                worktree,
                orig: None,
            });
        } else if rec.starts_with("2 ") {
            // "2 XY sub mH mI mW hH hI Xscore ruta" seguido de la ruta original en otro registro
            let mut it = rec.splitn(10, ' ');
            let xy: Vec<char> = it.nth(1).unwrap_or("..").chars().collect();
            let path = it.nth(7).unwrap_or("").to_string();
            let orig = parts.next().map(str::to_string);
            st.files.push(FileStatus {
                path,
                index: xy[0],
                worktree: xy[1],
                orig,
            });
        }
    }
    st
}

/// Contenido de un archivo en HEAD (`rev` = "HEAD") o en el índice (`rev` = ""),
/// o `None` si no existe ahí (archivo nuevo).
#[tauri::command]
pub async fn git_show(root: String, path: String, rev: String) -> Result<Option<String>, String> {
    if rev != "HEAD" && !rev.is_empty() {
        return Err("revisión no permitida".into());
    }
    blocking(move || {
        let out = git(&root, &["show", &format!("{rev}:{path}")])?;
        Ok(out
            .status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).into_owned()))
    })
    .await
}

#[tauri::command]
pub async fn git_branches(root: String) -> Result<Vec<String>, String> {
    blocking(move || {
        let out = git_ok(
            &root,
            &[
                "branch",
                "--format=%(refname:short)",
                "--sort=-committerdate",
            ],
        )?;
        Ok(out
            .lines()
            .map(str::to_string)
            .filter(|l| !l.is_empty())
            .collect())
    })
    .await
}

/// Operaciones que cambian el repositorio. `args` se valida para no ejecutar cualquier cosa.
#[tauri::command]
pub async fn git_run(root: String, args: Vec<String>) -> Result<String, String> {
    const ALLOWED: &[&str] = &[
        "add", "restore", "commit", "push", "pull", "fetch", "switch",
    ];
    if !args.first().is_some_and(|a| ALLOWED.contains(&a.as_str())) {
        return Err(format!(
            "operación git no permitida: {}",
            args.first().map_or("", |s| s)
        ));
    }
    blocking(move || {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let out = git(&root, &refs)?;
        let stdout = String::from_utf8_lossy(&out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);
        // push/pull escriben el progreso en stderr aunque todo vaya bien.
        let all = format!("{}{}", stdout, stderr).trim().to_string();
        if out.status.success() {
            Ok(all)
        } else {
            Err(all)
        }
    })
    .await
}

/// Commit con el mensaje en un archivo temporal (sin problemas de comillas ni saltos de línea).
#[tauri::command]
pub async fn git_commit(root: String, message: String, amend: bool) -> Result<String, String> {
    blocking(move || {
        let tmp =
            std::env::temp_dir().join(format!("editor-angular-commit-{}.txt", std::process::id()));
        std::fs::write(&tmp, &message).map_err(|e| e.to_string())?;
        let file = tmp.to_string_lossy().into_owned();
        let mut args = vec!["commit", "-F", &file];
        if amend {
            args.push("--amend");
        }
        let r = git_ok(&root, &args);
        let _ = std::fs::remove_file(&tmp);
        r.map(|s| s.trim().to_string())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Crea un repo real con: modificado, preparado, nuevo, borrado, renombrado y con espacios.
    #[test]
    fn parsea_estado_real() {
        let dir = std::env::temp_dir().join(format!("ea-git-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src/app")).unwrap();
        let d = dir.to_string_lossy().to_string();
        let run = |a: &[&str]| assert!(git(&d, a).unwrap().status.success(), "git {a:?}");
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.email", "t@t"]);
        run(&["config", "user.name", "t"]);
        for f in ["a.ts", "b.ts", "c.ts", "src/app/viejo.ts"] {
            std::fs::write(dir.join(f), format!("{f}\nlinea\n")).unwrap();
        }
        run(&["add", "-A"]);
        run(&["commit", "-qm", "inicial"]);
        std::fs::write(dir.join("a.ts"), "cambiado\n").unwrap(); // modificado sin preparar
        std::fs::write(dir.join("b.ts"), "preparado\n").unwrap();
        run(&["add", "b.ts"]); // modificado y preparado
        std::fs::remove_file(dir.join("c.ts")).unwrap(); // borrado
        run(&["mv", "src/app/viejo.ts", "src/app/nuevo.ts"]); // renombrado
        std::fs::write(dir.join("src/app/con espacio.ts"), "x\n").unwrap(); // nuevo con espacio

        let raw = git_ok(
            &d,
            &[
                "status",
                "--porcelain=v2",
                "--branch",
                "-z",
                "--untracked-files=all",
            ],
        )
        .unwrap();
        let st = parse_status(d.clone(), &raw);
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(st.branch.as_deref(), Some("main"));
        let find = |p: &str| {
            st.files
                .iter()
                .find(|f| f.path == p)
                .unwrap_or_else(|| panic!("falta {p}"))
        };
        assert_eq!((find("a.ts").index, find("a.ts").worktree), ('.', 'M'));
        assert_eq!((find("b.ts").index, find("b.ts").worktree), ('M', '.'));
        assert_eq!(find("c.ts").worktree, 'D');
        let r = find("src/app/nuevo.ts");
        assert_eq!(
            (r.index, r.orig.as_deref()),
            ('R', Some("src/app/viejo.ts"))
        );
        assert_eq!(find("src/app/con espacio.ts").index, '?');
        assert_eq!(st.files.len(), 5);
    }
}
