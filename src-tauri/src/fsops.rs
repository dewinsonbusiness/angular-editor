//! Operaciones sobre archivos desde el árbol y vigilancia de cambios en disco.

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::State;

use crate::SKIP_DIRS;

#[tauri::command]
pub async fn create_file(path: String) -> Result<(), String> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_dir(path: String) -> Result<(), String> {
    fs::create_dir(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rename_path(from: String, to: String) -> Result<(), String> {
    // En Windows renombrar solo cambiando mayúsculas ("app.ts" → "App.ts") es válido
    // aunque `to` "exista"; en cualquier otro caso no se pisa nada.
    if Path::new(&to).exists() && from.to_lowercase() != to.to_lowercase() {
        return Err(format!("ya existe {to}"));
    }
    fs::rename(&from, &to).map_err(|e| e.to_string())
}

/// Mueve a la papelera (recuperable), nunca borra definitivamente.
#[tauri::command]
pub async fn delete_path(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    #[cfg(windows)]
    let r = std::process::Command::new("explorer").arg(format!("/select,{path}")).spawn();
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").args(["-R", &path]).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = std::process::Command::new("xdg-open")
        .arg(Path::new(&path).parent().unwrap_or(Path::new("/")))
        .spawn();
    r.map(|_| ()).map_err(|e| e.to_string())
}

// ---------- Angular CLI ----------

#[derive(Serialize)]
pub struct GenerateResult {
    /// Raíz del workspace; las rutas de la salida (`CREATE src/...`) son relativas a ella.
    workspace: String,
    /// "nx" o "ng".
    tool: &'static str,
    command: String,
    output: String,
}

pub(crate) enum Workspace {
    Nx { root: PathBuf, bin: PathBuf },
    Ng { root: PathBuf, bin: PathBuf },
}

/// Ruta del ejecutable de `nx` según el campo `bin` de su package.json (cambia entre versiones).
fn nx_bin(root: &Path) -> Option<PathBuf> {
    let pkg_dir = root.join("node_modules/nx");
    let pkg: serde_json::Value = serde_json::from_str(&fs::read_to_string(pkg_dir.join("package.json")).ok()?).ok()?;
    let rel = match &pkg["bin"] {
        serde_json::Value::String(s) => s.clone(),
        v => v["nx"].as_str()?.to_string(),
    };
    Some(pkg_dir.join(rel)).filter(|p| p.exists())
}

/// Comando de instalación según el gestor de paquetes del workspace.
fn install_hint(root: &Path) -> &'static str {
    if root.join("pnpm-lock.yaml").exists() || root.join("pnpm-workspace.yaml").exists() {
        "pnpm install"
    } else if root.join("yarn.lock").exists() {
        "yarn install"
    } else if root.join("bun.lockb").exists() || root.join("bun.lock").exists() {
        "bun install"
    } else {
        "npm install"
    }
}

fn not_installed(root: &Path, what: &str) -> String {
    let why = if root.join("node_modules").exists() {
        format!("node_modules existe pero falta {what}.")
    } else {
        "No hay carpeta node_modules: las dependencias no están instaladas.".to_string()
    };
    format!(
        "Workspace encontrado en {}\n\n{why}\n\nEjecuta en esa carpeta:\n    {}",
        root.display(),
        install_hint(root)
    )
}

/// Busca hacia arriba desde `cwd`. Nx tiene prioridad: un `nx.json`, o un `project.json`
/// dentro de un repo con `nx` instalado. Si no, el `angular.json` más cercano.
pub(crate) fn detect_workspace(cwd: &Path) -> Result<Workspace, String> {
    let mut saw_project_json = false;
    let mut angular_root: Option<PathBuf> = None;
    for dir in cwd.ancestors() {
        saw_project_json |= dir.join("project.json").exists();
        if dir.join("nx.json").exists() || (saw_project_json && dir.join("node_modules/nx").exists()) {
            let bin = nx_bin(dir).ok_or_else(|| not_installed(dir, "el paquete `nx`"))?;
            return Ok(Workspace::Nx { root: dir.to_path_buf(), bin });
        }
        if angular_root.is_none() && dir.join("angular.json").exists() {
            angular_root = Some(dir.to_path_buf());
        }
    }
    let root = angular_root
        .ok_or("No se encontró nx.json, project.json ni angular.json en esta carpeta ni en sus superiores.")?;
    let bin = root.join("node_modules/@angular/cli/bin/ng.js");
    if !bin.exists() {
        return Err(not_installed(&root, "el paquete `@angular/cli`"));
    }
    Ok(Workspace::Ng { root, bin })
}

/// `ng generate` o `nx g` según el workspace que contiene `cwd`, sin preguntas interactivas.
#[tauri::command]
pub async fn ng_generate(cwd: String, schematic: String, name: String) -> Result<GenerateResult, String> {
    let (root, bin, tool, args): (PathBuf, PathBuf, &'static str, Vec<String>) =
        match detect_workspace(Path::new(&cwd))? {
            Workspace::Ng { root, bin } => {
                let args = vec!["generate".into(), schematic, name, "--defaults".into(), "--interactive=false".into()];
                (root, bin, "ng", args)
            }
            Workspace::Nx { root, bin } => {
                // @nx/angular solo trae component/directive/pipe; el resto sale de @schematics/angular.
                let has_nx_angular = root.join("node_modules/@nx/angular").exists();
                let nx_native = has_nx_angular && matches!(schematic.as_str(), "component" | "directive" | "pipe");
                let generator = if nx_native {
                    format!("@nx/angular:{schematic}")
                } else {
                    format!("@schematics/angular:{schematic}")
                };
                // Nx usa la ruta tal cual: para imitar a `ng`, el componente va en su propia carpeta.
                let target = if nx_native && schematic == "component" {
                    let last = name.rsplit('/').next().unwrap_or(&name).to_string();
                    format!("{name}/{last}")
                } else {
                    name
                };
                (root, bin, "nx", vec!["g".into(), generator, target, "--no-interactive".into()])
            }
        };
    let command = format!("{tool} {}", args.join(" "));
    let output = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = std::process::Command::new("node");
        cmd.arg(bin)
            .args(&args)
            .current_dir(&cwd)
            .env("NG_CLI_ANALYTICS", "false")
            .env("NX_TUI", "false")
            .env("NO_COLOR", "1")
            .env("FORCE_COLOR", "0")
            .stdin(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let out = cmd.output().map_err(|e| format!("no se pudo ejecutar node: {e}"))?;
        let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        if out.status.success() {
            Ok(stdout)
        } else {
            Err(if stderr.trim().is_empty() { stdout } else { stderr })
        }
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(GenerateResult { workspace: root.to_string_lossy().into_owned(), tool, command, output })
}

// ---------- configuración del editor ----------

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dunce::simplified(&dir).join("settings.json"))
}

/// Contenido de settings.json, o "{}" si todavía no existe.
#[tauri::command]
pub async fn read_settings(app: tauri::AppHandle) -> Result<String, String> {
    match fs::read_to_string(settings_path(&app)?) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("{}".into()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn write_settings(app: tauri::AppHandle, contents: String) -> Result<(), String> {
    let path = settings_path(&app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // Escritura atómica: primero a un temporal y luego se reemplaza.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

// ---------- vigilancia ----------

#[derive(Default)]
pub struct Watcher(Mutex<Option<Debouncer<RecommendedWatcher>>>);

#[derive(Serialize)]
pub struct FsChange {
    path: String,
    exists: bool,
    is_dir: bool,
}

fn skipped(path: &Path) -> bool {
    // De .git solo interesan HEAD (cambio de rama) e index (stage/commit), para refrescar Git.
    let parent_is_git = path.parent().and_then(|p| p.file_name()).is_some_and(|n| n == ".git");
    if parent_is_git && path.file_name().is_some_and(|n| n == "HEAD" || n == "index") {
        return false;
    }
    path.components()
        .any(|c| SKIP_DIRS.iter().any(|s| c.as_os_str() == *s))
}

/// Vigila `root` recursivamente y manda lotes de cambios (agrupados cada 250 ms).
/// Llamarlo de nuevo reemplaza (y detiene) la vigilancia anterior.
#[tauri::command]
pub fn watch_root(
    watcher: State<Watcher>,
    root: String,
    on_change: Channel<Vec<FsChange>>,
) -> Result<(), String> {
    let mut debouncer = new_debouncer(Duration::from_millis(250), move |res: DebounceEventResult| {
        let Ok(events) = res else { return };
        let mut changes: Vec<FsChange> = events
            .into_iter()
            .filter(|e| !skipped(&e.path))
            .map(|e| FsChange {
                exists: e.path.exists(),
                is_dir: e.path.is_dir(),
                path: e.path.to_string_lossy().into_owned(),
            })
            .collect();
        changes.sort_by(|a, b| a.path.cmp(&b.path));
        changes.dedup_by(|a, b| a.path == b.path);
        if !changes.is_empty() {
            let _ = on_change.send(changes);
        }
    })
    .map_err(|e| e.to_string())?;
    debouncer
        .watcher()
        .watch(Path::new(&root), RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    *watcher.0.lock().unwrap() = Some(debouncer);
    Ok(())
}
