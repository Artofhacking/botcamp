// Windows ships first. The same entry is what macOS, Android, and iOS call later.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("BotCamp 窗口没有起来");
}
