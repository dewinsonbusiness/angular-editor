//! Operaciones sobre archivos desde el árbol y vigilancia de cambios en disco.

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::Serialize;
use std::fs;
use std::path::Path;
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
