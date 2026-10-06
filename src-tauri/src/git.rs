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

#[derive(Serialize, Clone, Default)]
pub struct BlameCommit {
    hash: String,
    author: String,
    email: String,
    /// Segundos desde 1970 (fecha del autor).
    time: i64,
    summary: String,
}

#[derive(Serialize)]
pub struct Blame {
    commits: Vec<BlameCommit>,
    /// Para cada línea del documento (0-based), índice en `commits`.
    lines: Vec<u32>,
}

/// `git blame` del contenido actual del editor (con `--contents -`, así las líneas coinciden
/// aunque haya cambios sin guardar). Las líneas sin commit tienen hash de ceros.
#[tauri::command]
pub async fn git_blame(root: String, path: String, contents: String) -> Result<Blame, String> {
    blocking(move || {
        let mut cmd = Command::new("git");
        cmd.args(["blame", "--porcelain", "--contents", "-", "--", &path])
            .current_dir(&root)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let mut child = cmd.spawn().map_err(|e| format!("no se pudo ejecutar git: {e}"))?;
        let mut stdin = child.stdin.take().unwrap();
        // Escribir en otro hilo para no bloquearse si git empieza a responder antes de leerlo todo.
        let writer = std::thread::spawn(move || {
            use std::io::Write;
            let _ = stdin.write_all(contents.as_bytes());
        });
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        let _ = writer.join();
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(parse_blame(&String::from_utf8_lossy(&out.stdout)))
    })
    .await
}

fn parse_blame(raw: &str) -> Blame {
    use std::collections::HashMap;
    let mut commits: Vec<BlameCommit> = Vec::new();
    let mut index: HashMap<String, u32> = HashMap::new();
    let mut lines: Vec<u32> = Vec::new();
    let mut current: Option<u32> = None;
    let mut final_line = 0usize;
    for line in raw.lines() {
        if line.starts_with('\t') {
            // Contenido de la línea: cierra el bloque de cabecera.
            if let Some(c) = current {
                if lines.len() <= final_line {
                    lines.resize(final_line + 1, 0);
                }
                lines[final_line] = c;
            }
            continue;
        }
        let mut parts = line.splitn(2, ' ');
        let key = parts.next().unwrap_or("");
        let value = parts.next().unwrap_or("");
        if key.len() == 40 && key.chars().all(|c| c.is_ascii_hexdigit()) {
            // "<hash> <línea original> <línea final> [<n líneas>]"
            final_line = value.split(' ').nth(1).and_then(|n| n.parse::<usize>().ok()).unwrap_or(1) - 1;
            let idx = *index.entry(key.to_string()).or_insert_with(|| {
                commits.push(BlameCommit { hash: key.to_string(), ..Default::default() });
                (commits.len() - 1) as u32
            });
            current = Some(idx);
            continue;
        }
        if let Some(c) = current {
            let commit = &mut commits[c as usize];
            match key {
                "author" => commit.author = value.to_string(),
                "author-mail" => commit.email = value.trim_matches(|c| c == '<' || c == '>').to_string(),
                "author-time" => commit.time = value.parse().unwrap_or(0),
                "summary" => commit.summary = value.to_string(),
                _ => {}
            }
        }
    }
    Blame { commits, lines }
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

    /// Blame con una línea nueva sin guardar delante de dos líneas de un commit.
    #[test]
    fn parsea_blame_real() {
        let dir = std::env::temp_dir().join(format!("ea-blame-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let d = dir.to_string_lossy().to_string();
        let run = |a: &[&str]| assert!(git(&d, a).unwrap().status.success(), "git {a:?}");
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.email", "ana@x.com"]);
        run(&["config", "user.name", "Ana Pérez"]);
        std::fs::write(dir.join("a.ts"), "uno\ndos\n").unwrap();
        run(&["add", "-A"]);
        run(&["commit", "-qm", "feat: primer commit"]);
        // Contenido "del editor": una línea nueva arriba.
        let edited = dir.join("editado.txt");
        std::fs::write(&edited, "nueva\nuno\ndos\n").unwrap();
        let raw = git_ok(&d, &["blame", "--porcelain", "--contents", &edited.to_string_lossy(), "--", "a.ts"]).unwrap();
        let _ = std::fs::remove_dir_all(&dir);

        let b = parse_blame(&raw);
        assert_eq!(b.lines.len(), 3);
        let c = |i: usize| &b.commits[b.lines[i] as usize];
        assert!(c(0).hash.chars().all(|ch| ch == '0'), "la línea nueva no tiene commit");
        assert_eq!(c(1).author, "Ana Pérez");
        assert_eq!(c(1).email, "ana@x.com");
        assert_eq!(c(1).summary, "feat: primer commit");
        assert!(c(1).time > 0);
        assert_eq!(c(1).hash, c(2).hash);
    }

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
