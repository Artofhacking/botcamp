//! Show the built page inside the window. There is no local web server and
//! the document is not `tauri://localhost`. macOS WebKit left both of those
//! blank: it does not run the page's module script from the custom scheme,
//! and 0.1.2's loopback page never appeared for the person using the app.

pub const WINDOW_TITLE: &str = concat!("BotCamp ", env!("CARGO_PKG_VERSION"));
#[cfg(target_os = "macos")]
const PAGE_ORIGIN: &str = "https://botcamp.demox.site/";

pub fn show(window: &tauri::WebviewWindow) {
    let html = include_str!(concat!(env!("OUT_DIR"), "/standalone.html")).to_string();
    #[cfg(target_os = "macos")]
    show_mac(window, html);
    #[cfg(windows)]
    show_windows(window, html);
    #[cfg(not(any(target_os = "macos", windows)))]
    show_fallback(window, html);
}

#[cfg(target_os = "macos")]
fn show_mac(window: &tauri::WebviewWindow, html: String) {
    let _ = window.with_webview(move |webview| {
        use objc2::rc::Retained;
        use objc2_foundation::{NSString, NSURL};
        use objc2_web_kit::WKWebView;
        let ptr = webview.inner().cast::<WKWebView>();
        let Some(view) = (unsafe { Retained::retain(ptr) }) else { return };
        let markup = NSString::from_str(&html);
        let base = NSURL::URLWithString(&NSString::from_str(PAGE_ORIGIN));
        let _ = unsafe { view.loadHTMLString_baseURL(&markup, base.as_deref()) };
    });
}

#[cfg(windows)]
fn show_windows(window: &tauri::WebviewWindow, html: String) {
    let _ = window.with_webview(move |webview| {
        let Ok(core) = (unsafe { webview.controller().CoreWebView2() }) else { return };
        let text = windows_core::HSTRING::from(html);
        let _ = unsafe { core.NavigateToString(&text) };
    });
}

#[cfg(not(any(target_os = "macos", windows)))]
fn show_fallback(window: &tauri::WebviewWindow, html: String) {
    let script = format!(
        "document.open();document.write({});document.close();",
        serde_json::to_string(&html).unwrap_or_else(|_| "\"\"".to_string())
    );
    let _ = window.eval(&script);
}
