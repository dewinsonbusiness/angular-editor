mod fsops;
mod lsp;

use ignore::WalkBuilder;
use serde::Serialize;
use std::fs;
use std::path::Path;
use tauri::Manager;

/// Directorios que nunca queremos recorrer, aunque no estén en .gitignore.
pub(crate) const SKIP_DIRS: &[&str] = &["node_modules", ".git", ".angular", "dist", ".nx", "coverage"];
const MAX_FILES: usize = 50_000;
const MAX_HITS: usize = 2_000;
const MAX_SEARCH_FILE_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Serialize)]
struct Entry {
    name: String,
    path: String,
    is_dir: bool,
}

#[derive(Serialize)]
struct Hit {
    path: String,
    line: usize,
    col: usize,
    text: String,
}

fn walker(root: &str) -> ignore::Walk {
    WalkBuilder::new(root)
        .hidden(false)
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !(e.file_type().map_or(false, |t| t.is_dir()) && SKIP_DIRS.contains(&name.as_ref()))
        })
        .build()
}

fn rel(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .unwrap_or(p)
        .to_string_lossy()
        .replace('\\', "/")
}

/// Lista un directorio (un nivel). Carpetas primero, luego archivos, alfabético.
#[tauri::command]
async fn list_dir(path: String) -> Result<Vec<Entry>, String> {
    let mut out: Vec<Entry> = fs::read_dir(&path)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .filter(|e| e.file_name() != ".git")
        .map(|e| Entry {
            name: e.file_name().to_string_lossy().into_owned(),
            path: e.path().to_string_lossy().into_owned(),
            is_dir: e.file_type().map_or(false, |t| t.is_dir()),
        })
        .collect();
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

#[tauri::command]
async fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn write_file(path: String, contents: String) -> Result<(), String> {
    fs::write(&path, contents).map_err(|e| e.to_string())
}

/// Todos los archivos del proyecto (rutas relativas) para Ctrl+P.
#[tauri::command]
async fn list_files(root: String) -> Result<Vec<String>, String> {
    let root_path = Path::new(&root);
    Ok(walker(&root)
        .filter_map(|r| r.ok())
        .filter(|e| e.file_type().map_or(false, |t| t.is_file()))
        .take(MAX_FILES)
        .map(|e| rel(root_path, e.path()))
        .collect())
}

/// Búsqueda de texto literal en todo el proyecto.
#[tauri::command]
async fn search(root: String, query: String, case_sensitive: bool) -> Result<Vec<Hit>, String> {
    if query.is_empty() {
        return Ok(vec![]);
    }
    let root_path = Path::new(&root);
    let needle = if case_sensitive { query.clone() } else { query.to_lowercase() };
    let mut hits = Vec::new();

    for entry in walker(&root).filter_map(|r| r.ok()) {
        if !entry.file_type().map_or(false, |t| t.is_file()) {
            continue;
        }
        if entry.metadata().map_or(true, |m| m.len() > MAX_SEARCH_FILE_BYTES) {
            continue;
        }
        // Archivos binarios o no-UTF8 se ignoran.
        let Ok(text) = fs::read_to_string(entry.path()) else { continue };
        for (i, line) in text.lines().enumerate() {
            let hay = if case_sensitive { line.to_string() } else { line.to_lowercase() };
            if let Some(byte_col) = hay.find(&needle) {
                hits.push(Hit {
                    path: rel(root_path, entry.path()),
                    line: i + 1,
                    col: hay[..byte_col].chars().count(),
                    text: line.trim().chars().take(200).collect(),
                });
                if hits.len() >= MAX_HITS {
                    return Ok(hits);
                }
            }
        }
    }
    Ok(hits)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(lsp::Servers::default())
        .manage(fsops::Watcher::default())
        .invoke_handler(tauri::generate_handler![
            list_dir,
            read_file,
            write_file,
            list_files,
            search,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            fsops::create_file,
            fsops::create_dir,
            fsops::rename_path,
            fsops::delete_path,
            fsops::reveal_in_explorer,
            fsops::watch_root
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // En Windows los procesos hijos no mueren con el padre: hay que matarlos.
            if let tauri::RunEvent::Exit = event {
                app.state::<lsp::Servers>().kill_all();
            }
        });
}
