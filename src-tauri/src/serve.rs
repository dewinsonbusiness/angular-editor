//! `nx serve` / `ng serve` en segundo plano, con la salida enviada al panel del editor.

use ignore::WalkBuilder;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::State;

use crate::fsops::{detect_workspace, Workspace};
use crate::SKIP_DIRS;

#[derive(Serialize)]
pub struct ServeTargets {
    workspace: String,
    tool: &'static str,
    projects: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ServeEvent {
    Line { err: bool, text: String },
    Exit { code: Option<i32> },
}

/// id de sesión → pid del proceso raíz.
#[derive(Default)]
pub struct Serves(Mutex<HashMap<String, u32>>);

impl Serves {
    pub fn stop_all(&self) {
        for (_, pid) in self.0.lock().unwrap().drain() {
            kill_tree(pid);
        }
    }
}

#[cfg(windows)]
fn no_window(cmd: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000) // CREATE_NO_WINDOW
}
#[cfg(not(windows))]
fn no_window(cmd: &mut Command) -> &mut Command {
    cmd
}

/// Nx/Angular lanzan procesos hijos: hay que matar el árbol entero o el puerto queda ocupado.
fn kill_tree(pid: u32) {
    #[cfg(windows)]
    let _ = no_window(Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    #[cfg(not(windows))]
    let _ = Command::new("pkill").args(["-TERM", "-P", &pid.to_string()]).status();
    #[cfg(not(windows))]
    let _ = Command::new("kill").args(["-TERM", &pid.to_string()]).status();
}

fn json(path: &Path) -> Option<serde_json::Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

/// Lectura rápida (sin ejecutar nx): proyectos con target `serve` declarado explícitamente.
#[tauri::command]
pub async fn serve_targets(root: String) -> Result<ServeTargets, String> {
    match detect_workspace(Path::new(&root))? {
        Workspace::Nx { root, .. } => {
            let mut projects: Vec<String> = WalkBuilder::new(&root)
                .filter_entry(|e| !SKIP_DIRS.iter().any(|s| e.file_name() == *s))
                .build()
                .filter_map(|r| r.ok())
                .filter(|e| e.file_name() == "project.json")
                .filter_map(|e| {
                    let v = json(e.path())?;
                    v["targets"].get("serve")?;
                    let dir_name = e.path().parent()?.file_name()?.to_string_lossy().into_owned();
                    Some(v["name"].as_str().map(str::to_string).unwrap_or(dir_name))
                })
                .collect();
            projects.sort_by_key(|p| p.to_lowercase());
            Ok(ServeTargets { workspace: root.to_string_lossy().into_owned(), tool: "nx", projects })
        }
        Workspace::Ng { root, .. } => {
            let v = json(&root.join("angular.json")).ok_or("angular.json no válido")?;
            let mut projects: Vec<String> = v["projects"]
                .as_object()
                .map(|o| {
                    o.iter()
                        .filter(|(_, p)| p["architect"].get("serve").or(p["targets"].get("serve")).is_some())
                        .map(|(name, _)| name.clone())
                        .collect()
                })
                .unwrap_or_default();
            projects.sort_by_key(|p| p.to_lowercase());
            Ok(ServeTargets { workspace: root.to_string_lossy().into_owned(), tool: "ng", projects })
        }
    }
}

/// Lista completa según Nx (incluye targets inferidos por plugins). Lento la primera vez.
#[tauri::command]
pub async fn serve_targets_nx(root: String) -> Result<Vec<String>, String> {
    let Workspace::Nx { root, bin } = detect_workspace(Path::new(&root))? else {
        return Ok(vec![]);
    };
    tauri::async_runtime::spawn_blocking(move || {
        let out = no_window(
            Command::new("node")
                .arg(bin)
                .args(["show", "projects", "--with-target", "serve", "--json"])
                .current_dir(&root)
                .env("NX_TUI", "false")
                .env("NO_COLOR", "1")
                .stdin(Stdio::null()),
        )
        .output()
        .map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&out.stdout);
        // Puede haber avisos antes del JSON: tomar desde el primer '['.
        let start = text.find('[').ok_or("salida inesperada de nx show projects")?;
        serde_json::from_str::<Vec<String>>(text[start..].trim()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn pump(stream: impl Read + Send + 'static, err: bool, ch: Channel<ServeEvent>) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let text = String::from_utf8_lossy(&buf).trim_end_matches(['\r', '\n']).to_string();
                    if ch.send(ServeEvent::Line { err, text }).is_err() {
                        break;
                    }
                }
            }
        }
    })
}

#[tauri::command]
pub fn serve_start(
    serves: State<'_, Serves>,
    id: String,
    root: String,
    project: String,
    port: Option<u16>,
    on_event: Channel<ServeEvent>,
) -> Result<(), String> {
    let (ws_root, bin) = match detect_workspace(Path::new(&root))? {
        Workspace::Nx { root, bin } | Workspace::Ng { root, bin } => (root, bin),
    };
    let mut args = vec!["serve".to_string(), project];
    if let Some(p) = port {
        args.push(format!("--port={p}"));
    }
    let mut child = no_window(
        Command::new("node")
            .arg(&bin)
            .args(&args)
            .current_dir(&ws_root)
            .env("NX_TUI", "false")
            .env("NG_CLI_ANALYTICS", "false")
            .env("NO_COLOR", "1")
            .env("FORCE_COLOR", "0")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()),
    )
    .spawn()
    .map_err(|e| format!("no se pudo ejecutar node: {e}"))?;

    let out = pump(child.stdout.take().unwrap(), false, on_event.clone());
    let err = pump(child.stderr.take().unwrap(), true, on_event.clone());
    serves.0.lock().unwrap().insert(id, child.id());

    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code());
        let _ = out.join();
        let _ = err.join();
        let _ = on_event.send(ServeEvent::Exit { code });
    });
    Ok(())
}

#[tauri::command]
pub fn serve_stop(serves: State<'_, Serves>, id: String) {
    if let Some(pid) = serves.0.lock().unwrap().remove(&id) {
        kill_tree(pid);
    }
}

/// Al recargar la interfaz se pierden las sesiones: se detienen las huérfanas.
#[tauri::command]
pub fn serve_stop_all(serves: State<'_, Serves>) {
    serves.stop_all();
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("URL no permitida".into());
    }
    #[cfg(windows)]
    let r = no_window(Command::new("cmd").args(["/C", "start", "", &url])).spawn();
    #[cfg(target_os = "macos")]
    let r = Command::new("open").arg(&url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = Command::new("xdg-open").arg(&url).spawn();
    r.map(|_| ()).map_err(|e| e.to_string())
}
