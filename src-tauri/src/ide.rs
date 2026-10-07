//! Integración con Claude Code: el mismo mecanismo que la extensión de VS Code.
//!
//! - Servidor WebSocket en 127.0.0.1 con un puerto aleatorio y un token por arranque.
//! - Archivo `~/.claude/ide/<puerto>.lock` que anuncia el editor al CLI `claude`.
//! - Rust solo hace de puente: cada mensaje JSON-RPC (MCP) va y viene del frontend,
//!   que es quien conoce las pestañas, la selección y los diagnósticos.

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::{HeaderValue, StatusCode};
use tokio_tungstenite::tungstenite::Message;

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum IdeEvent {
    /// `conn` identifica a cada sesión de `claude` conectada (puede haber varias a la vez).
    Connected { conn: u64 },
    Message { conn: u64, data: String },
    Disconnected { conn: u64 },
}

#[derive(Default)]
pub struct Ide {
    port: Mutex<u16>,
    token: Mutex<String>,
    lock_path: Mutex<Option<PathBuf>>,
    folders: Mutex<Vec<String>>,
    /// Sesiones de `claude` conectadas: id de conexión → canal de salida.
    clients: Mutex<std::collections::HashMap<u64, mpsc::UnboundedSender<String>>>,
    frontend: Mutex<Option<Channel<IdeEvent>>>,
}

impl Ide {
    fn emit(&self, ev: IdeEvent) {
        if let Some(ch) = self.frontend.lock().unwrap().as_ref() {
            let _ = ch.send(ev);
        }
    }

    fn write_lock(&self) {
        let Some(path) = self.lock_path.lock().unwrap().clone() else { return };
        let body = serde_json::json!({
            "pid": std::process::id(),
            "workspaceFolders": *self.folders.lock().unwrap(),
            "ideName": "Editor Angular",
            "transport": "ws",
            "runningInWindows": cfg!(windows),
            "authToken": *self.token.lock().unwrap(),
        });
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Err(e) = std::fs::write(&path, body.to_string()) {
            eprintln!("[ide] no se pudo escribir {}: {e}", path.display());
        }
    }

    pub fn remove_lock(&self) {
        if let Some(path) = self.lock_path.lock().unwrap().take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// `CLAUDE_CONFIG_DIR` o `~/.claude`, igual que la extensión de VS Code.
fn claude_config_dir(app: &AppHandle) -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        return Some(PathBuf::from(dir));
    }
    app.path().home_dir().ok().map(|h| dunce::simplified(&h).join(".claude"))
}

async fn bind_random_port() -> Option<(TcpListener, u16)> {
    for _ in 0..50 {
        let port = 10_000 + (uuid::Uuid::new_v4().as_u128() % 55_536) as u16;
        if let Ok(l) = TcpListener::bind(("127.0.0.1", port)).await {
            return Some((l, port));
        }
    }
    None
}

/// Arranca el servidor al iniciar la app. Si falla, el editor funciona igual sin Claude.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let Some((listener, port)) = bind_random_port().await else {
            eprintln!("[ide] no se encontró un puerto libre");
            return;
        };
        let ide = app.state::<Ide>();
        *ide.port.lock().unwrap() = port;
        *ide.token.lock().unwrap() = uuid::Uuid::new_v4().to_string();
        *ide.lock_path.lock().unwrap() = claude_config_dir(&app).map(|d| d.join("ide").join(format!("{port}.lock")));
        ide.write_lock();

        let mut next_id: u64 = 0;
        while let Ok((stream, _)) = listener.accept().await {
            next_id += 1;
            let app = app.clone();
            let conn_id = next_id;
            tauri::async_runtime::spawn(async move { handle(app, stream, conn_id).await });
        }
    });
}

async fn handle(app: AppHandle, stream: tokio::net::TcpStream, conn_id: u64) {
    let token = app.state::<Ide>().token.lock().unwrap().clone();
    let check = |req: &Request, mut resp: Response| -> Result<Response, ErrorResponse> {
        let ok = req
            .headers()
            .get("x-claude-code-ide-authorization")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v == token);
        if !ok {
            let mut err = ErrorResponse::new(Some("Unauthorized".into()));
            *err.status_mut() = StatusCode::UNAUTHORIZED;
            return Err(err);
        }
        // Devolver el subprotocolo que pida el cliente (el cliente `ws` falla si no se repite).
        if let Some(proto) = req.headers().get("sec-websocket-protocol").and_then(|v| v.to_str().ok()) {
            let first = proto.split(',').next().unwrap_or("").trim().to_string();
            if let Ok(v) = HeaderValue::from_str(&first) {
                resp.headers_mut().insert("sec-websocket-protocol", v);
            }
        }
        Ok(resp)
    };
    let Ok(ws) = tokio_tungstenite::accept_hdr_async(stream, check).await else { return };
    let (mut sink, mut source) = ws.split();

    // Varias sesiones a la vez (a diferencia de VS Code): cada una con su propio canal.
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    {
        let ide = app.state::<Ide>();
        ide.clients.lock().unwrap().insert(conn_id, tx);
        ide.emit(IdeEvent::Connected { conn: conn_id });
    }

    let writer = tauri::async_runtime::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    while let Some(Ok(msg)) = source.next().await {
        match msg {
            Message::Text(t) => app.state::<Ide>().emit(IdeEvent::Message { conn: conn_id, data: t.to_string() }),
            Message::Close(_) => break,
            _ => {}
        }
    }

    let ide = app.state::<Ide>();
    ide.clients.lock().unwrap().remove(&conn_id);
    ide.emit(IdeEvent::Disconnected { conn: conn_id });
    writer.abort();
}

#[derive(Serialize)]
pub struct IdeInfo {
    port: u16,
    clients: Vec<u64>,
}

/// El frontend se registra para recibir los mensajes del CLI (también tras recargar la interfaz).
#[tauri::command]
pub fn ide_attach(ide: State<'_, Ide>, on_event: Channel<IdeEvent>) -> IdeInfo {
    *ide.frontend.lock().unwrap() = Some(on_event);
    IdeInfo { port: *ide.port.lock().unwrap(), clients: ide.clients.lock().unwrap().keys().copied().collect() }
}

#[tauri::command]
/// Envía a una sesión concreta (`conn`) o, sin `conn`, a todas (notificaciones como la selección).
#[allow(clippy::needless_pass_by_value)]
pub fn ide_send(ide: State<'_, Ide>, conn: Option<u64>, message: String) -> Result<(), String> {
    let clients = ide.clients.lock().unwrap();
    match conn {
        Some(c) => clients.get(&c).ok_or("esa sesión de Claude ya no está conectada")?.send(message).map_err(|e| e.to_string()),
        None => {
            for tx in clients.values() {
                let _ = tx.send(message.clone());
            }
            Ok(())
        }
    }
}

/// Carpetas del proyecto abierto, para que `claude` sepa a qué editor conectarse.
#[tauri::command]
pub fn ide_set_workspace(ide: State<'_, Ide>, folders: Vec<String>) {
    *ide.folders.lock().unwrap() = folders;
    ide.write_lock();
}
