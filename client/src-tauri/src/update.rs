//! On launch, look for a newer installer on the public download page and switch to it.
//! The copy already on disk only starts doing this once it includes this check.

use std::collections::HashMap;
use std::io::Read;
use std::time::Duration;

use serde::Deserialize;

const MANIFEST: &str = "https://botcamp.demox.site/download/latest.json";
const LIMIT: u64 = 40_000_000;

#[derive(Deserialize)]
struct Manifest {
    version: String,
    platforms: HashMap<String, String>,
}

pub fn spawn() {
    std::thread::spawn(|| {
        let _ = check();
    });
}

fn check() -> Result<(), String> {
    let Some(key) = platform_key() else { return Ok(()) };
    let manifest = fetch_manifest()?;
    if !newer(env!("CARGO_PKG_VERSION"), &manifest.version) {
        return Ok(());
    }
    let url = manifest.platforms.get(key).ok_or("没有这一版的安装包。")?;
    if !allowed_url(url) {
        return Err("更新地址不在下载页。".into());
    }
    let bytes = download(url)?;
    apply(&bytes)
}

fn fetch_manifest() -> Result<Manifest, String> {
    let response = ureq::get(MANIFEST)
        .timeout(Duration::from_secs(8))
        .call()
        .map_err(|error| error.to_string())?;
    let text = response.into_string().map_err(|error| error.to_string())?;
    serde_json::from_str(&text).map_err(|error| error.to_string())
}

fn download(url: &str) -> Result<Vec<u8>, String> {
    let response = ureq::get(url)
        .timeout(Duration::from_secs(60))
        .call()
        .map_err(|error| error.to_string())?;
    let mut body = Vec::new();
    response
        .into_reader()
        .take(LIMIT + 1)
        .read_to_end(&mut body)
        .map_err(|error| error.to_string())?;
    if body.len() as u64 > LIMIT {
        return Err("安装包太大。".into());
    }
    Ok(body)
}

pub fn newer(current: &str, latest: &str) -> bool {
    let current = parts(current);
    let latest = parts(latest);
    let width = current.len().max(latest.len());
    for index in 0..width {
        let left = current.get(index).copied().unwrap_or(0);
        let right = latest.get(index).copied().unwrap_or(0);
        if right > left {
            return true;
        }
        if right < left {
            return false;
        }
    }
    false
}

fn parts(value: &str) -> Vec<u64> {
    value
        .split(|c: char| !c.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse().ok())
        .collect()
}

pub fn allowed_url(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else { return false };
    url.scheme() == "https"
        && url.host_str() == Some("botcamp.demox.site")
        && url.path().starts_with("/download/")
        && !url.path().contains("..")
}

fn platform_key() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("darwin-aarch64"),
        ("macos", "x86_64") => Some("darwin-x86_64"),
        ("windows", "x86_64") => Some("windows-x86_64"),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
fn apply(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < 4 || &bytes[..2] != b"PK" {
        return Err("不是 Mac 安装包。".into());
    }
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let app = exe
        .parent()
        .and_then(|path| path.parent())
        .and_then(|path| path.parent())
        .ok_or("找不到 BotCamp.app")?;
    if app.extension().and_then(|ext| ext.to_str()) != Some("app") {
        return Ok(());
    }
    let stage = std::env::temp_dir().join(format!("botcamp-update-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&stage);
    std::fs::create_dir_all(&stage).map_err(|error| error.to_string())?;
    let zip_path = stage.join("update.zip");
    std::fs::write(&zip_path, bytes).map_err(|error| error.to_string())?;
    let unpack = stage.join("unpack");
    std::fs::create_dir_all(&unpack).map_err(|error| error.to_string())?;
    let unpacked = std::process::Command::new("ditto")
        .arg("-xk")
        .arg(&zip_path)
        .arg(&unpack)
        .status();
    let ok = match unpacked {
        Ok(status) if status.success() => true,
        _ => std::process::Command::new("unzip")
            .arg("-q")
            .arg("-o")
            .arg(&zip_path)
            .arg("-d")
            .arg(&unpack)
            .status()
            .map(|status| status.success())
            .unwrap_or(false),
    };
    if !ok {
        return Err("没能解开新的安装包。".into());
    }
    let new_app = unpack.join("BotCamp.app");
    if !new_app.join("Contents/MacOS/botcamp").is_file() {
        return Err("包里没有 BotCamp。".into());
    }
    let script_path = std::env::temp_dir().join(format!("botcamp-swap-{}.sh", std::process::id()));
    let script = format!(
        "#!/bin/sh\nwhile kill -0 {pid} 2>/dev/null; do sleep 0.2; done\nrm -rf {app}\nmv {new_app} {app}\nxattr -cr {app} 2>/dev/null || true\nopen {app}\nrm -rf {stage} {script}\n",
        pid = std::process::id(),
        app = shell_quote(app),
        new_app = shell_quote(&new_app),
        stage = shell_quote(&stage),
        script = shell_quote(&script_path),
    );
    std::fs::write(&script_path, script).map_err(|error| error.to_string())?;
    std::process::Command::new("sh")
        .arg(&script_path)
        .spawn()
        .map_err(|error| error.to_string())?;
    std::process::exit(0);
}

#[cfg(target_os = "windows")]
fn apply(bytes: &[u8]) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    if bytes.len() < 2 || &bytes[..2] != b"MZ" {
        return Err("不是 Windows 安装包。".into());
    }
    let dir = std::env::temp_dir().join(format!("botcamp-update-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let installer = dir.join("BotCamp-setup.exe");
    std::fs::write(&installer, bytes).map_err(|error| error.to_string())?;
    std::process::Command::new(&installer)
        .arg("/S")
        .creation_flags(0x0000_0008 | 0x0000_0200)
        .spawn()
        .map_err(|error| error.to_string())?;
    std::process::exit(0);
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn apply(_bytes: &[u8]) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn shell_quote(path: &std::path::Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::{allowed_url, newer};

    #[test]
    fn a_newer_version_is_detected() {
        assert!(newer("0.1.0", "0.1.1"));
        assert!(newer("0.1.1", "0.2.0"));
        assert!(newer("0.9.9", "1.0.0"));
        assert!(!newer("0.1.1", "0.1.1"));
        assert!(!newer("0.1.1", "0.1.0"));
    }

    #[test]
    fn updates_only_come_from_the_download_page() {
        assert!(allowed_url("https://botcamp.demox.site/download/BotCamp-mac-apple-silicon.zip"));
        assert!(!allowed_url("http://botcamp.demox.site/download/BotCamp-mac-apple-silicon.zip"));
        assert!(!allowed_url("https://example.com/download/BotCamp-mac-apple-silicon.zip"));
        assert!(!allowed_url("https://botcamp.demox.site/download/../secret"));
    }
}
