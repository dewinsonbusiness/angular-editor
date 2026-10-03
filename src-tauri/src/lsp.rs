//! Puente entre el frontend y los language servers (procesos Node por stdio).
//! El frontend manda/recibe mensajes JSON-RPC sin cabeceras; aquí se añade y
//! se quita el framing `Content-Length` del protocolo LSP.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

struct Server {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
pub struct Servers(Mutex<HashMap<String, Server>>);

impl Servers {
    pub fn kill_all(&self) {
        for (_, mut s) in self.0.lock().unwrap().drain() {
            let _ = s.child.kill();
        }
    }
}

/// Carpeta `lsp-servers` (con su `node_modules`): dentro de los recursos de la app
/// instalada o, en desarrollo, la del repositorio.
fn servers_home(app: &AppHandle) -> PathBuf {
    if let Ok(res) = app.path().resource_dir() {
        // En Windows resource_dir() devuelve rutas "\\?\C:\..." que Node no sabe
        // ejecutar (falla con EISDIR lstat 'C:'): hay que pasarlas a ruta normal.
        let bundled = dunce::simplified(&res).join("lsp-servers");
        if bundled.join("node_modules/@angular/language-server").exists() {
            return bundled;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("lsp-servers")
}

fn server_args(app: &AppHandle, kind: &str, root: &str) -> Result<Vec<String>, String> {
    let home = servers_home(app);
    let nm = home.join("node_modules");
    let home = home.to_string_lossy().into_owned();
    match kind {
        "typescript" => Ok(vec![
            nm.join("typescript-language-server/lib/cli.mjs").to_string_lossy().into_owned(),
            "--stdio".into(),
        ]),
        // Se prefiere el @angular/language-service del proyecto (coincide con su
        // versión de Angular); si no existe, se usa el incluido con el editor.
        "angular" => Ok(vec![
            nm.join("@angular/language-server/index.js").to_string_lossy().into_owned(),
            "--stdio".into(),
            "--tsProbeLocations".into(),
            format!("{home},{root}"),
            "--ngProbeLocations".into(),
            format!("{root},{home}"),
        ]),
        _ => Err(format!("servidor desconocido: {kind}")),
    }
}

/// Lee mensajes con framing LSP de `stdout` y los reenvía al frontend.
fn pump(stdout: impl Read, on_message: Channel<String>) {
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        let mut len: Option<usize> = None;
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
            let l = line.trim_end();
            if l.is_empty() {
                break;
            }
            if let Some(v) = l.strip_prefix("Content-Length:") {
                len = v.trim().parse().ok();
            }
        }
        let Some(len) = len else { continue };
        let mut body = vec![0u8; len];
        if reader.read_exact(&mut body).is_err() {
            return;
        }
        if on_message.send(String::from_utf8_lossy(&body).into_owned()).is_err() {
            return;
        }
    }
}

#[tauri::command]
pub fn lsp_start(
    app: AppHandle,
    servers: State<Servers>,
    id: String,
    kind: String,
    root: String,
    on_message: Channel<String>,
) -> Result<(), String> {
    if let Some(mut old) = servers.0.lock().unwrap().remove(&id) {
        let _ = old.child.kill();
    }

    let mut cmd = Command::new("node");
    cmd.args(server_args(&app, &kind, &root)?)
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("no se pudo iniciar node ({kind}): {e}"))?;

    let stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    // Las últimas líneas de stderr se guardan para explicar por qué murió el servidor.
    let tag = id.clone();
    let stderr_thread = std::thread::spawn(move || {
        let mut tail: Vec<String> = Vec::new();
        for l in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("[lsp {tag}] {l}");
            tail.push(l);
            if tail.len() > 30 {
                tail.remove(0);
            }
        }
        tail
    });
    let exit_channel = on_message.clone();
    std::thread::spawn(move || {
        pump(stdout, on_message);
        let tail = stderr_thread.join().unwrap_or_default();
        // Aviso sintético para que el frontend sepa que el servidor murió y por qué.
        let msg = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "$/editor/exited",
            "params": { "stderr": tail.join("\n") },
        });
        let _ = exit_channel.send(msg.to_string());
    });

    servers.0.lock().unwrap().insert(id, Server { child, stdin });
    Ok(())
}

/// Envía uno o más mensajes en orden. Es síncrono a propósito: el frontend
/// encadena las llamadas y así se preserva el orden de didChange.
#[tauri::command]
pub fn lsp_send(servers: State<Servers>, id: String, messages: Vec<String>) -> Result<(), String> {
    let mut map = servers.0.lock().unwrap();
    let server = map.get_mut(&id).ok_or("servidor no iniciado")?;
    let mut buf = Vec::new();
    for m in &messages {
        write!(buf, "Content-Length: {}\r\n\r\n", m.len()).unwrap();
        buf.extend_from_slice(m.as_bytes());
    }
    server
        .stdin
        .write_all(&buf)
        .and_then(|_| server.stdin.flush())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn lsp_stop(servers: State<Servers>, id: String) {
    if let Some(mut s) = servers.0.lock().unwrap().remove(&id) {
        let _ = s.child.kill();
    }
}
