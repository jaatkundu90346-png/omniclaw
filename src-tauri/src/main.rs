use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::Manager;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

enum GatewayHandle {
    Node(Child),
    Sidecar(CommandChild),
}

impl GatewayHandle {
    fn kill(self) {
        match self {
            GatewayHandle::Node(mut child) => {
                let _ = child.kill();
            }
            GatewayHandle::Sidecar(child) => {
                let _ = child.kill();
            }
        }
    }
}

struct GatewayProcess(Mutex<Option<GatewayHandle>>);

fn has_gateway(dir: &Path) -> bool {
    dir.join("server.js").is_file()
}

fn find_gateway_root() -> Option<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd);
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            candidates.push(exe_dir.to_path_buf());
        }
    }

    if let Some(source_root) = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent() {
        candidates.push(source_root.to_path_buf());
    }

    for candidate in candidates {
        for dir in candidate.ancestors().take(8) {
            if has_gateway(dir) {
                return Some(dir.to_path_buf());
            }
        }
    }

    None
}

fn spawn_gateway_node() -> Option<Child> {
    let root = find_gateway_root()?;

    Command::new("node")
        .arg("server.js")
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()
}

fn spawn_gateway_sidecar(app: &tauri::AppHandle) -> Option<CommandChild> {
    let command = app.shell().sidecar("omniclaw-gateway").ok()?;
    let (mut rx, child) = command.spawn().ok()?;

    tauri::async_runtime::spawn(async move {
        while rx.recv().await.is_some() {}
    });

    Some(child)
}

fn spawn_gateway(app: &tauri::AppHandle) -> Option<GatewayHandle> {
    if let Some(child) = spawn_gateway_sidecar(app) {
        return Some(GatewayHandle::Sidecar(child));
    }

    spawn_gateway_node().map(GatewayHandle::Node)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(GatewayProcess(Mutex::new(None)))
        .setup(|app| {
            #[cfg(not(debug_assertions))]
            {
                if let Some(child) = spawn_gateway(app.handle()) {
                    let state = app.state::<GatewayProcess>();
                    *state.0.lock().expect("gateway state lock poisoned") = Some(child);
                    std::thread::sleep(std::time::Duration::from_millis(900));
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                let state = window.state::<GatewayProcess>();
                if let Ok(mut guard) = state.0.lock() {
                    if let Some(child) = guard.take() {
                        child.kill();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running OmniClaw desktop shell");
}
