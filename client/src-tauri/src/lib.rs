// Each person's desktop runs Chrome. The Demox function never does.
mod update;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::Manager;

struct Browser {
    child: Option<Child>,
    port: u16,
}

struct Desk(Mutex<HashMap<String, Browser>>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CookieIn {
    name: String,
    value: String,
    domain: String,
    path: String,
    expires: f64,
    http_only: bool,
    secure: bool,
    same_site: String,
}

fn bot_ok(id: &str) -> bool {
    matches!(id, "co_chief" | "co_writer" | "co_ops")
}

fn chrome_path() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("BOTCAMP_CHROME") {
        let candidate = PathBuf::from(path);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    let mut candidates = vec![
        PathBuf::from("/usr/bin/google-chrome"),
        PathBuf::from("/usr/bin/google-chrome-stable"),
        PathBuf::from("/usr/bin/chromium"),
        PathBuf::from("/usr/bin/chromium-browser"),
        PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        PathBuf::from("/Applications/Chromium.app/Contents/MacOS/Chromium"),
    ];
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        candidates.push(PathBuf::from(local).join("Google/Chrome/Application/chrome.exe"));
    }
    if let Ok(program) = std::env::var("PROGRAMFILES") {
        candidates.push(PathBuf::from(program).join("Google/Chrome/Application/chrome.exe"));
    }
    if let Ok(program) = std::env::var("PROGRAMFILES(X86)") {
        candidates.push(PathBuf::from(program).join("Google/Chrome/Application/chrome.exe"));
    }
    candidates.into_iter().find(|path| path.is_file()).ok_or_else(|| "这台电脑没有找到 Chrome。".to_string())
}

fn profile_dir(app: &tauri::AppHandle, bot_id: &str) -> Result<PathBuf, String> {
    let root = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let dir = root.join("browsers").join(bot_id);
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn devtools_up(port: u16) -> bool {
    ureq::get(&format!("http://127.0.0.1:{port}/json/version"))
        .timeout(Duration::from_millis(400))
        .call()
        .is_ok()
}

fn wait_devtools(port: u16) -> Result<(), String> {
    for _ in 0..40 {
        if devtools_up(port) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(150));
    }
    Err("本机浏览器没有在这台电脑上起来。".to_string())
}

fn page_socket(port: u16) -> Result<String, String> {
    let text = ureq::get(&format!("http://127.0.0.1:{port}/json/list"))
        .timeout(Duration::from_secs(3))
        .call()
        .map_err(|_| "连不上这台电脑上的浏览器。".to_string())?
        .into_string()
        .map_err(|error| error.to_string())?;
    let list: Vec<Value> = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    list.iter()
        .find(|item| item.get("type").and_then(|kind| kind.as_str()) == Some("page"))
        .and_then(|item| item.get("webSocketDebuggerUrl").and_then(|url| url.as_str()).map(str::to_string))
        .ok_or_else(|| "浏览器里还没有页面。".to_string())
}

fn cdp(port: u16, method: &str, params: Value) -> Result<Value, String> {
    let url = page_socket(port)?;
    let (mut socket, _) = tungstenite::connect(url).map_err(|error| error.to_string())?;
    if let tungstenite::stream::MaybeTlsStream::Plain(stream) = socket.get_ref() {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(20)));
    }
    let id = 1;
    let body = json!({ "id": id, "method": method, "params": params });
    socket
        .send(tungstenite::Message::Text(body.to_string()))
        .map_err(|error| error.to_string())?;
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        if std::time::Instant::now() > deadline {
            return Err("浏览器没有在时间内回答。".to_string());
        }
        let message = socket.read().map_err(|error| error.to_string())?;
        let text = match message {
            tungstenite::Message::Text(text) => text.to_string(),
            tungstenite::Message::Ping(payload) => {
                let _ = socket.send(tungstenite::Message::Pong(payload));
                continue;
            }
            _ => continue,
        };
        let value: Value = match serde_json::from_str(&text) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if value.get("id").and_then(|item| item.as_i64()) != Some(id) {
            continue;
        }
        if let Some(error) = value.get("error") {
            return Err(error.to_string());
        }
        return Ok(value.get("result").cloned().unwrap_or(Value::Null));
    }
}

fn still_running(browser: &mut Browser) -> bool {
    match browser.child.as_mut() {
        Some(child) => matches!(child.try_wait(), Ok(None)),
        None => true,
    }
}

fn ensure(app: &tauri::AppHandle, desk: &Desk, bot_id: &str) -> Result<u16, String> {
    if !bot_ok(bot_id) {
        return Err("这个 Bot 没有本机浏览器。".to_string());
    }
    let dir = profile_dir(app, bot_id)?;
    {
        let mut map = desk.0.lock().map_err(|_| "本机浏览器正忙。".to_string())?;
        if let Some(browser) = map.get_mut(bot_id) {
            if still_running(browser) && devtools_up(browser.port) {
                return Ok(browser.port);
            }
        }
    }
    let remembered = fs::read_to_string(dir.join("botcamp-port")).ok().and_then(|text| text.trim().parse().ok());
    if let Some(port) = remembered {
        if devtools_up(port) {
            let mut map = desk.0.lock().map_err(|_| "本机浏览器正忙。".to_string())?;
            map.insert(bot_id.to_string(), Browser { child: None, port });
            return Ok(port);
        }
    }
    let path = chrome_path()?;
    let mut last = "本机浏览器没有起来。".to_string();
    for port in 9333..9348 {
        if devtools_up(port) {
            continue;
        }
        let child = match Command::new(&path)
            .arg(format!("--user-data-dir={}", dir.display()))
            .arg(format!("--remote-debugging-port={port}"))
            .arg("--remote-debugging-address=127.0.0.1")
            .arg("--no-first-run")
            .arg("--no-default-browser-check")
            .arg("--disable-sync")
            .arg("--new-window")
            .arg("about:blank")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => child,
            Err(error) => {
                last = error.to_string();
                continue;
            }
        };
        if wait_devtools(port).is_err() {
            last = "本机浏览器没有在这台电脑上起来。".to_string();
            continue;
        }
        let _ = fs::write(dir.join("botcamp-port"), port.to_string());
        let mut map = desk.0.lock().map_err(|_| "本机浏览器正忙。".to_string())?;
        map.insert(bot_id.to_string(), Browser { child: Some(child), port });
        return Ok(port);
    }
    Err(last)
}

fn snapshot(port: u16) -> Result<Value, String> {
    let result = cdp(port, "Runtime.evaluate", json!({
        "expression": "({url: location.href, title: document.title, ready: document.readyState, canGoBack: history.length > 1, canGoForward: false})",
        "returnByValue": true,
    }))?;
    Ok(result.get("result").and_then(|item| item.get("value")).cloned().unwrap_or(json!({})))
}

fn wait_ready(port: u16) -> Result<Value, String> {
    let mut last = json!({});
    for _ in 0..24 {
        last = snapshot(port)?;
        let ready = last.get("ready").and_then(|item| item.as_str()).unwrap_or("");
        if ready == "complete" || ready == "interactive" {
            return Ok(last);
        }
        thread::sleep(Duration::from_millis(250));
    }
    Ok(last)
}

fn public_page(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|_| "只能打开 http 或 https。".to_string())?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err("只能打开 http 或 https。".to_string());
    }
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    if host.is_empty()
        || host == "localhost"
        || host.ends_with(".localhost")
        || host == "metadata.google.internal"
        || host.starts_with("127.")
        || host.starts_with("10.")
        || host.starts_with("192.168.")
        || host.starts_with("169.254.")
        || host == "0.0.0.0"
    {
        return Err("这个地址不在这里打开。".to_string());
    }
    Ok(())
}

#[tauri::command]
fn desktop_browser_navigate(app: tauri::AppHandle, desk: tauri::State<Desk>, bot_id: String, url: String) -> Result<Value, String> {
    public_page(&url)?;
    let port = ensure(&app, &desk, &bot_id)?;
    cdp(port, "Page.navigate", json!({ "url": url }))?;
    wait_ready(port)
}

#[tauri::command]
fn desktop_browser_eval(app: tauri::AppHandle, desk: tauri::State<Desk>, bot_id: String, script: String) -> Result<Value, String> {
    if script.len() > 200_000 {
        return Err("读页面的脚本太长了。".to_string());
    }
    let port = ensure(&app, &desk, &bot_id)?;
    let result = cdp(port, "Runtime.evaluate", json!({
        "expression": script,
        "returnByValue": true,
        "awaitPromise": true,
    }))?;
    if let Some(message) = result.pointer("/exceptionDetails/text").and_then(|item| item.as_str()) {
        return Err(message.to_string());
    }
    Ok(result.get("result").and_then(|item| item.get("value")).cloned().unwrap_or(Value::Null))
}

#[tauri::command]
fn desktop_browser_command(app: tauri::AppHandle, desk: tauri::State<Desk>, bot_id: String, name: String) -> Result<Value, String> {
    let expression = match name.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        "stop" => "window.stop()",
        _ => return Err("没有这个浏览器动作。".to_string()),
    };
    let port = ensure(&app, &desk, &bot_id)?;
    cdp(port, "Runtime.evaluate", json!({ "expression": expression, "returnByValue": true }))?;
    thread::sleep(Duration::from_millis(400));
    wait_ready(port)
}

#[tauri::command]
fn desktop_browser_cookies(app: tauri::AppHandle, desk: tauri::State<Desk>, bot_id: String, cookies: Vec<CookieIn>) -> Result<Value, String> {
    let port = ensure(&app, &desk, &bot_id)?;
    let mut stored = 0;
    let mut failed = Vec::new();
    for cookie in cookies {
        let path = if cookie.path.is_empty() { "/".to_string() } else { cookie.path.clone() };
        let mut params = json!({
            "name": cookie.name,
            "value": cookie.value,
            "domain": cookie.domain,
            "path": path,
            "httpOnly": cookie.http_only,
            "secure": cookie.secure,
        });
        if cookie.expires > 0.0 {
            params["expires"] = json!(cookie.expires);
        }
        if matches!(cookie.same_site.as_str(), "Strict" | "Lax" | "None") {
            params["sameSite"] = json!(cookie.same_site);
        }
        match cdp(port, "Network.setCookie", params) {
            Ok(result) if result.get("success").and_then(|item| item.as_bool()) != Some(false) => stored += 1,
            Ok(_) => failed.push(json!({ "name": cookie.name, "reason": "refused" })),
            Err(error) => {
                let reason = error.replace(&cookie.value, "…");
                failed.push(json!({ "name": cookie.name, "reason": reason }));
            }
        }
    }
    Ok(json!({ "stored": stored, "failed": failed, "dropped": [] }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    update::spawn();
    tauri::Builder::default()
        .manage(Desk(Mutex::new(HashMap::new())))
        .invoke_handler(tauri::generate_handler![
            desktop_browser_navigate,
            desktop_browser_eval,
            desktop_browser_command,
            desktop_browser_cookies,
        ])
        .build(tauri::generate_context!())
        .expect("BotCamp 窗口没有起来")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(desk) = app.try_state::<Desk>() {
                    if let Ok(mut map) = desk.0.lock() {
                        for (_, mut browser) in map.drain() {
                            if let Some(child) = browser.child.as_mut() {
                                let _ = child.kill();
                            }
                        }
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::public_page;

    #[test]
    fn blocks_metadata_and_allows_https() {
        assert!(public_page("https://www.xiaoheihe.cn/").is_ok());
        assert!(public_page("http://169.254.169.254/").is_err());
        assert!(public_page("https://metadata.google.internal/").is_err());
        assert!(public_page("file:///etc/passwd").is_err());
    }
}
