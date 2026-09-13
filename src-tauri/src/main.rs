#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, ChildStderr, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::sleep;
use std::time::{Duration, Instant};
use tauri::path::BaseDirectory;
use tauri::{Manager, RunEvent, State};

const DEFAULT_API_BASE_URL: &str = "http://127.0.0.1:3001";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const PORT_ATTEMPTS: usize = 8;
const MAX_STARTUP_STDERR_BYTES: usize = 16 * 1024;

#[derive(Default)]
struct LocalApi {
    base_url: Mutex<String>,
    startup_error: Mutex<Option<String>>,
    child: Mutex<Option<Child>>,
}

impl LocalApi {
    fn new() -> Self {
        Self {
            base_url: Mutex::new(DEFAULT_API_BASE_URL.to_owned()),
            startup_error: Mutex::new(None),
            child: Mutex::new(None),
        }
    }

    fn shutdown(&self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(mut child) = child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

#[tauri::command]
fn local_api_base_url(api: State<'_, LocalApi>) -> Result<String, String> {
    if let Ok(error) = api.startup_error.lock() {
        if let Some(message) = error.as_ref() {
            return Err(message.clone());
        }
    }
    api.base_url
        .lock()
        .map(|url| url.clone())
        .map_err(|_| "The local document API startup state is unavailable.".to_owned())
}

fn free_loopback_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("Could not reserve a local API port: {error}"))?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("Could not read the local API port: {error}"))
}

fn health_check(port: u16) -> bool {
    let address = format!("127.0.0.1:{port}");
    let Ok(mut stream) = TcpStream::connect_timeout(
        &address.parse().expect("loopback socket address is valid"),
        Duration::from_millis(250),
    ) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    if stream
        .write_all(b"GET /api/health HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = Vec::with_capacity(2048);
    let mut chunk = [0_u8; 512];
    loop {
        let Ok(length) = stream.read(&mut chunk) else {
            return false;
        };
        if length == 0 {
            break;
        }
        response.extend_from_slice(&chunk[..length]);
        if response.len() > 16 * 1024 {
            return false;
        }
    }
    let response = String::from_utf8_lossy(&response);
    (response.starts_with("HTTP/1.1 200 ") || response.starts_with("HTTP/1.0 200 "))
        && response.contains("\"conversion\":\"document-svg+raster-images\"")
}

enum StartupResult {
    Ready,
    Exited(String),
    TimedOut,
}

fn drain_child_stderr(
    mut stderr: ChildStderr,
) -> (Arc<Mutex<Vec<u8>>>, std::thread::JoinHandle<()>) {
    let captured = Arc::new(Mutex::new(Vec::with_capacity(MAX_STARTUP_STDERR_BYTES)));
    let writer = Arc::clone(&captured);
    let task = std::thread::spawn(move || {
        let mut chunk = [0_u8; 1024];
        loop {
            let Ok(length) = stderr.read(&mut chunk) else {
                break;
            };
            if length == 0 {
                break;
            }
            let Ok(mut bytes) = writer.lock() else {
                break;
            };
            bytes.extend_from_slice(&chunk[..length]);
            if bytes.len() > MAX_STARTUP_STDERR_BYTES {
                let excess = bytes.len() - MAX_STARTUP_STDERR_BYTES;
                bytes.drain(..excess);
            }
        }
    });
    (captured, task)
}

fn startup_stderr(captured: &Arc<Mutex<Vec<u8>>>, reader: std::thread::JoinHandle<()>) -> String {
    let _ = reader.join();
    captured
        .lock()
        .map(|bytes| String::from_utf8_lossy(&bytes).trim().to_owned())
        .unwrap_or_default()
}

fn wait_for_api(child: &mut Child, port: u16, ready: &mpsc::Receiver<()>) -> StartupResult {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    let mut child_ready = false;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(status)) => {
                return StartupResult::Exited(format!("process exited with {status}"))
            }
            Err(error) => {
                return StartupResult::Exited(format!("could not monitor process: {error}"))
            }
            Ok(None) => {}
        }
        child_ready |= ready.try_recv().is_ok();
        if child_ready && health_check(port) {
            return StartupResult::Ready;
        }
        sleep(Duration::from_millis(100));
    }
    StartupResult::TimedOut
}

fn runtime_paths(app: &tauri::App<tauri::Wry>) -> Result<(PathBuf, PathBuf), String> {
    let runtime = app
        .path()
        .resolve("desktop-runtime", BaseDirectory::Resource)
        .map_err(|error| format!("Could not locate the packaged API runtime: {error}"))?;
    let node = runtime.join("bin").join(if cfg!(target_os = "windows") {
        "node.exe"
    } else {
        "node"
    });
    Ok((runtime, node))
}

fn start_local_api(app: &tauri::App<tauri::Wry>) -> Result<(), String> {
    let (runtime, node) = runtime_paths(app)?;
    if !node.is_file() {
        if cfg!(debug_assertions) {
            // `tauri dev` starts the normal npm API through its beforeDevCommand.
            return Ok(());
        }
        return Err("The packaged Node.js API runtime is missing. Rebuild the desktop package with its runtime resources.".to_owned());
    }
    let server = runtime.join("server").join("index.ts");
    if !server.is_file() {
        return Err("The packaged document API entry point is missing.".to_owned());
    }

    // Keep an existing Annotation Studio API configured on the old default
    // port usable during upgrades; unrelated services are not accepted.
    let force_bundled = std::env::var("ANNOTATION_STUDIO_FORCE_SIDECAR").as_deref() == Ok("1");
    if !force_bundled && health_check(3001) {
        *app.state::<LocalApi>()
            .base_url
            .lock()
            .map_err(|_| "The local API startup state is unavailable.".to_owned())? =
            DEFAULT_API_BASE_URL.to_owned();
        return Ok(());
    }

    let data_directory = match std::env::var_os("ANNOTATION_STUDIO_DATA_DIR") {
        Some(path) => PathBuf::from(path),
        None => app
            .path()
            .app_data_dir()
            .map_err(|error| format!("Could not locate the app data directory: {error}"))?
            .join("session-state"),
    };
    std::fs::create_dir_all(&data_directory)
        .map_err(|error| format!("Could not create the API data directory: {error}"))?;

    let api = app.state::<LocalApi>();
    let mut last_error = String::from("The local document API did not become ready.");
    for _ in 0..PORT_ATTEMPTS {
        let port = free_loopback_port()?;
        let token = format!(
            "{}-{port}-{:x}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        let mut command = Command::new(&node);
        command
            .args(["--import", "tsx", "desktop-api-launcher.mjs"])
            .current_dir(&runtime)
            .env("NODE_ENV", "production")
            .env("HOST", "127.0.0.1")
            .env("PORT", port.to_string())
            .env("ANNOTATION_STUDIO_API_ONLY", "true")
            .env("ANNOTATION_STUDIO_STARTUP_TOKEN", &token)
            .env("ANNOTATION_STUDIO_DATA_DIR", &data_directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("Could not start the bundled document API: {error}"))?;

        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Could not monitor the bundled API startup errors.".to_owned())?;
        let (captured_stderr, stderr_reader) = drain_child_stderr(stderr);

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Could not monitor the bundled API startup handshake.".to_owned())?;
        let (ready_sender, ready_receiver) = mpsc::channel();
        let expected_line = format!("ANNOTATION_STUDIO_READY:{token}");
        std::thread::spawn(move || {
            let mut signaled = false;
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if !signaled && line.trim_end() == expected_line {
                    let _ = ready_sender.send(());
                    signaled = true;
                }
            }
        });

        match wait_for_api(&mut child, port, &ready_receiver) {
            StartupResult::Ready => {
                *api.base_url
                    .lock()
                    .map_err(|_| "The local API startup state is unavailable.".to_owned())? =
                    format!("http://127.0.0.1:{port}");
                *api.child
                    .lock()
                    .map_err(|_| "The local API process state is unavailable.".to_owned())? =
                    Some(child);
                return Ok(());
            }
            StartupResult::Exited(error) => {
                let diagnostic = startup_stderr(&captured_stderr, stderr_reader);
                last_error = if diagnostic.is_empty() {
                    format!("The bundled document API exited before becoming ready ({error}).")
                } else {
                    format!("The bundled document API exited before becoming ready ({error}). Stderr: {diagnostic}")
                };
            }
            StartupResult::TimedOut => {
                let _ = child.kill();
                let _ = child.wait();
                let diagnostic = startup_stderr(&captured_stderr, stderr_reader);
                let detail = if diagnostic.is_empty() {
                    String::new()
                } else {
                    format!(" Stderr: {diagnostic}")
                };
                return Err(format!("The bundled document API did not respond to its health check within 20 seconds.{detail}"));
            }
        }
    }
    Err(format!(
        "{last_error} Tried {PORT_ATTEMPTS} loopback ports."
    ))
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(LocalApi::new())
        .invoke_handler(tauri::generate_handler![local_api_base_url])
        .setup(|app| {
            if let Err(error) = start_local_api(app) {
                eprintln!("Annotation Studio API startup failed: {error}");
                if let Ok(mut state) = app.state::<LocalApi>().startup_error.lock() {
                    *state = Some(error);
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Annotation Studio");
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            handle.state::<LocalApi>().shutdown();
        }
    });
}
