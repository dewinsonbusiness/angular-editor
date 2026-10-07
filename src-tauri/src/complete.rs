//! Experimento: completar código a demanda (Alt+/) con el `claude` oficial instalado,
//! usando la suscripción del usuario. Es lento (varios segundos por petición) porque
//! `claude` arranca cada vez; por eso es a demanda y no mientras se escribe.

use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::State;

/// pid de la petición en curso, para poder cancelarla.
#[derive(Default)]
pub struct Completion(Mutex<Option<u32>>);

const SYSTEM: &str = "You are a code completion engine inside an Angular/TypeScript editor. \
You receive a file with a <CURSOR> marker. Reply ONLY with the exact text to insert at <CURSOR>: \
no explanations, no markdown, no code fences, do not repeat code that is already before or after \
the cursor. Match the surrounding indentation and style. If nothing sensible fits, reply with nothing.";

fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    let _ = Command::new("kill").arg(pid.to_string()).status();
}

#[tauri::command]
pub async fn claude_complete(
    state: State<'_, Completion>,
    cwd: String,
    prompt: String,
    model: String,
) -> Result<String, String> {
    // Una sola petición a la vez: la nueva cancela la anterior.
    if let Some(pid) = state.0.lock().unwrap().take() {
        kill_tree(pid);
    }
    let mut cmd = Command::new("claude");
    cmd.args([
        "-p",
        "--model", &model,
        "--tools", "",                 // sin herramientas: solo texto
        "--system-prompt", SYSTEM,
        "--setting-sources", "user",   // sin ajustes ni MCP del proyecto (más rápido)
        "--strict-mcp-config",
        "--no-session-persistence",
        "--disable-slash-commands",
        "--output-format", "text",
    ])
    .current_dir(&cwd)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    // Sin variables heredadas de otra sesión de Claude Code.
    for (key, _) in std::env::vars_os() {
        let k = key.to_string_lossy().to_uppercase();
        if k == "NO_COLOR" || k == "CLAUDECODE" || k.starts_with("CLAUDE_CODE_") {
            cmd.env_remove(&key);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| format!("no se pudo ejecutar claude: {e}"))?;
    *state.0.lock().unwrap() = Some(child.id());
    let mut stdin = child.stdin.take().unwrap();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(prompt.as_bytes());
    });
    let out = tauri::async_runtime::spawn_blocking(move || child.wait_with_output())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let _ = writer.join();
    state.0.lock().unwrap().take();
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { "cancelado".into() } else { err })
    }
}

#[tauri::command]
pub fn claude_complete_cancel(state: State<'_, Completion>) {
    if let Some(pid) = state.0.lock().unwrap().take() {
        kill_tree(pid);
    }
}
