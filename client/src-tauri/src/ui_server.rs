//! The Mac window stays white when the page is `tauri://localhost`.
//! WKWebView does not run a `<script type="module">` from that custom scheme,
//! so the document stays an empty white view. Serve the same embedded files
//! over `http://127.0.0.1`, which WebKit treats as a normal page.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

pub fn request_path(target: &str) -> Option<String> {
    if target.contains("..") || !target.starts_with('/') || target.starts_with("//") {
        return None;
    }
    let url = url::Url::parse(&format!("http://local{target}")).ok()?;
    let path = url.path().trim_start_matches('/');
    if path.is_empty() {
        Some("index.html".to_string())
    } else {
        Some(path.to_string())
    }
}

pub fn content_type(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("");
    match ext {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

#[cfg(dev)]
pub fn window_url<R: tauri::Runtime>(_app: &tauri::App<R>) -> String {
    "http://127.0.0.1:5195/".to_string()
}

#[cfg(not(dev))]
pub fn window_url<R: tauri::Runtime>(app: &tauri::App<R>) -> String {
    let port = start(app.asset_resolver());
    format!("http://127.0.0.1:{port}/")
}

#[cfg(not(dev))]
fn start<R: tauri::Runtime>(resolver: tauri::AssetResolver<R>) -> u16 {
    let mut files = HashMap::new();
    for (key, _) in resolver.iter() {
        let raw = key.replace('\\', "/");
        let Some(asset) = resolver.get(raw.clone()) else { continue };
        let stripped = raw.trim_start_matches('/').to_string();
        if stripped.is_empty() || stripped.split('/').any(|part| part == "..") {
            continue;
        }
        files.insert(stripped.clone(), asset.bytes.clone());
        if raw != stripped {
            files.insert(raw, asset.bytes);
        }
    }
    let files = Arc::new(files);
    let listener = TcpListener::bind("127.0.0.1:0").expect("本机页面端口没有打开");
    let port = listener.local_addr().expect("本机页面端口没有打开").port();
    thread::spawn(move || {
        for conn in listener.incoming().flatten() {
            let files = Arc::clone(&files);
            thread::spawn(move || {
                let _ = serve_one(conn, &files);
            });
        }
    });
    port
}

fn serve_one(mut stream: TcpStream, files: &HashMap<String, Vec<u8>>) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut buf = [0_u8; 8192];
    let n = stream.read(&mut buf)?;
    let text = String::from_utf8_lossy(&buf[..n]);
    let mut lines = text.lines();
    let request = lines.next().unwrap_or("");
    let mut parts = request.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("/");
    if method != "GET" && method != "HEAD" {
        return write_response(&mut stream, 405, "text/plain; charset=utf-8", b"method", method != "HEAD");
    }
    let Some(path) = request_path(target) else {
        return write_response(&mut stream, 400, "text/plain; charset=utf-8", b"bad path", method != "HEAD");
    };
    if let Some(body) = files.get(&path) {
        return write_response(&mut stream, 200, content_type(&path), body, method != "HEAD");
    }
    let missing = "<!doctype html><meta charset=utf-8><title>BotCamp</title><p>正在打开的页面不在这个包里。</p>";
    write_response(&mut stream, 404, "text/html; charset=utf-8", missing.as_bytes(), method != "HEAD")
}

fn write_response(stream: &mut TcpStream, status: u16, mime: &str, body: &[u8], include_body: bool) -> std::io::Result<()> {
    let reason = if status == 200 { "OK" } else if status == 404 { "Not Found" } else { "Error" };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\n\r\n",
        body.len()
    );
    stream.write_all(header.as_bytes())?;
    if include_body {
        stream.write_all(body)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{content_type, request_path};

    #[test]
    fn the_window_asks_for_the_page_and_its_script() {
        assert_eq!(request_path("/").as_deref(), Some("index.html"));
        assert_eq!(request_path("/index.html").as_deref(), Some("index.html"));
        assert_eq!(request_path("/assets/index.js").as_deref(), Some("assets/index.js"));
        assert_eq!(request_path("/assets/index.js?v=1").as_deref(), Some("assets/index.js"));
        assert!(request_path("/../secret").is_none());
        assert!(request_path("//evil").is_none());
    }

    #[test]
    fn a_module_script_gets_a_javascript_type() {
        assert_eq!(content_type("assets/index.js"), "text/javascript; charset=utf-8");
        assert_eq!(content_type("index.html"), "text/html; charset=utf-8");
        assert_eq!(content_type("app.css"), "text/css; charset=utf-8");
    }
}
