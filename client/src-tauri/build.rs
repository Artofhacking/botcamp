#[path = "src/inline_page.rs"]
mod inline_page;

use std::fs;
use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let dist = manifest.join("../../app/ui/dist");
    let index = dist.join("index.html");
    println!("cargo:rerun-if-changed={}", index.display());
    println!("cargo:rerun-if-changed=src/inline_page.rs");
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("standalone.html");
    if index.is_file() {
        let html = fs::read_to_string(&index).expect("读取客户端页面失败");
        let page = inline_page::assemble(&html, |path| fs::read_to_string(dist.join(path)).ok())
            .expect("客户端页面没有收成单个文档");
        fs::write(&out, page).expect("写入窗口页面失败");
    } else if std::env::var("PROFILE").as_deref() == Ok("release") {
        panic!("没有客户端页面。先构建 app 的 client，再编译窗口。");
    } else {
        fs::write(&out, "<!doctype html><title>BotCamp</title><p>正在打开 BotCamp…</p>").expect("写入窗口页面失败");
    }
    tauri_build::build();
}
