//! Terminal integrada: un pseudo-terminal (ConPTY en Windows) por pestaña de terminal.

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

struct Pty {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct Ptys(Mutex<HashMap<String, Pty>>);

impl Ptys {
    pub fn kill_all(&self) {
        for (_, mut p) in self.0.lock().unwrap().drain() {
            let _ = p.killer.kill();
        }
    }
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PtyEvent {
    Data { data: String },
    Exit { code: Option<u32> },
}

/// PowerShell 7 si está instalado; si no, Windows PowerShell.
fn default_shell() -> String {
    #[cfg(windows)]
    {
        let has_pwsh = std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).any(|d| d.join("pwsh.exe").exists()))
            .unwrap_or(false);
        if has_pwsh { "pwsh.exe".into() } else { "powershell.exe".into() }
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
    }
}

/// Reenvía la salida como texto, sin partir caracteres UTF-8 entre dos lecturas.
fn pump(mut reader: Box<dyn Read + Send>, ch: Channel<PtyEvent>) {
    let mut buf = [0u8; 16 * 1024];
    let mut pending: Vec<u8> = Vec::new();
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        pending.extend_from_slice(&buf[..n]);
        let valid = match std::str::from_utf8(&pending) {
            Ok(_) => pending.len(),
            // Secuencia incompleta al final: esperar a la siguiente lectura.
            Err(e) if e.error_len().is_none() => e.valid_up_to(),
            // Bytes inválidos: se envía todo con reemplazo.
            Err(_) => pending.len(),
        };
        if valid == 0 {
            continue;
        }
        let data = String::from_utf8_lossy(&pending[..valid]).into_owned();
        pending.drain(..valid);
        if ch.send(PtyEvent::Data { data }).is_err() {
            break;
        }
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn pty_spawn(
    app: AppHandle,
    ptys: State<'_, Ptys>,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    program: Option<String>,
    args: Vec<String>,
    env: HashMap<String, String>,
    on_event: Channel<PtyEvent>,
) -> Result<(), String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(program.unwrap_or_else(default_shell));
    cmd.args(&args);
    cmd.cwd(&cwd);
    // No heredar variables que quiten los colores o que hagan creer a `claude` que corre
    // dentro de otra sesión de Claude Code (pasa si el editor se abrió desde una).
    for (key, _) in std::env::vars_os() {
        let k = key.to_string_lossy().to_uppercase();
        if k == "NO_COLOR" || k == "FORCE_COLOR" || k == "CLAUDECODE" || k.starts_with("CLAUDE_CODE_") {
            cmd.env_remove(&key);
        }
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "editor-angular");
    for (k, v) in env {
        cmd.env(k, v);
    }

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();

    ptys.0.lock().unwrap().insert(id.clone(), Pty { master: pair.master, writer, killer });

    let out = on_event.clone();
    let reader_thread = std::thread::spawn(move || pump(reader, out));

    std::thread::spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code());
        // En Windows el lector no recibe EOF hasta que se cierra el maestro.
        app.state::<Ptys>().0.lock().unwrap().remove(&id);
        let _ = reader_thread.join();
        let _ = on_event.send(PtyEvent::Exit { code });
    });
    Ok(())
}

#[tauri::command]
pub fn pty_write(ptys: State<'_, Ptys>, id: String, data: String) -> Result<(), String> {
    let mut map = ptys.0.lock().unwrap();
    let p = map.get_mut(&id).ok_or("terminal cerrada")?;
    p.writer.write_all(data.as_bytes()).and_then(|_| p.writer.flush()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(ptys: State<'_, Ptys>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let map = ptys.0.lock().unwrap();
    let p = map.get(&id).ok_or("terminal cerrada")?;
    p.master
        .resize(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(ptys: State<'_, Ptys>, id: String) {
    if let Some(mut p) = ptys.0.lock().unwrap().remove(&id) {
        let _ = p.killer.kill();
    }
}

/// Si el portapapeles tiene una imagen (captura, foto copiada…), la guarda como PNG temporal
/// y devuelve su ruta; Claude Code adjunta la imagen al recibir esa ruta. `None` si no hay imagen.
#[tauri::command]
pub async fn clipboard_image_to_file() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        let Ok(img) = clipboard.get_image() else { return Ok(None) };

        let dir = std::env::temp_dir().join("editor-angular-imagenes");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        // Borrar las capturas de más de un día para no acumular basura.
        if let Ok(entries) = std::fs::read_dir(&dir) {
            let day = std::time::Duration::from_secs(24 * 3600);
            for e in entries.flatten() {
                let old = e.metadata().and_then(|m| m.modified()).ok()
                    .and_then(|t| t.elapsed().ok())
                    .is_some_and(|age| age > day);
                if old {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }

        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let path = dir.join(format!("captura-{stamp}.png"));
        let file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
        let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), img.width as u32, img.height as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(&img.bytes).map_err(|e| e.to_string())?;
        writer.finish().map_err(|e| e.to_string())?;
        Ok(Some(dunce::simplified(&path).to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Al recargar la interfaz se pierden las terminales: se cierran las huérfanas.
#[tauri::command]
pub fn pty_kill_all(ptys: State<'_, Ptys>) {
    ptys.kill_all();
}
