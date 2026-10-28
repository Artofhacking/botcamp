//! Turn the built page into one document. The window then shows that
//! document itself. Nothing has to listen on this computer, and the
//! document is not loaded from `tauri://localhost`.
#![allow(dead_code)]

pub fn assemble(html: &str, mut load: impl FnMut(&str) -> Option<String>) -> Result<String, String> {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    let mut saw_script = false;
    while let Some(start) = rest.find('<') {
        out.push_str(&rest[..start]);
        let Some(end) = rest[start..].find('>') else {
            return Err("页面里有没有结束的标签。".into());
        };
        let tag = &rest[start..start + end + 1];
        rest = &rest[start + end + 1..];
        if is_csp_meta(tag) || is_module_preload(tag) {
            continue;
        }
        if is_stylesheet(tag) {
            let href = attr(tag, "href").ok_or("样式没有地址。")?;
            let css = read_local(&mut load, href)?;
            out.push_str("<style>");
            out.push_str(&escape_close(&css, "</style"));
            out.push_str("</style>");
            continue;
        }
        if is_external_script(tag) {
            let src = attr(tag, "src").ok_or("脚本没有地址。")?;
            let js = read_local(&mut load, src)?;
            let closer = "</script>";
            let trimmed = rest.trim_start();
            if trimmed.len() >= closer.len() && trimmed[..closer.len()].eq_ignore_ascii_case(closer) {
                let skip = rest.len() - trimmed.len() + closer.len();
                rest = &rest[skip..];
            }
            out.push_str("<script type=\"module\">");
            out.push_str(&escape_close(&js, "</script"));
            out.push_str("</script>");
            saw_script = true;
            continue;
        }
        out.push_str(tag);
    }
    out.push_str(rest);
    if !saw_script {
        return Err("页面里没有可以放进窗口的脚本。".into());
    }
    Ok(out)
}

fn read_local(load: &mut impl FnMut(&str) -> Option<String>, href: &str) -> Result<String, String> {
    let path = local_asset(href).ok_or_else(|| format!("页面引用了窗口外面的文件：{href}"))?;
    load(path).ok_or_else(|| format!("页面缺了文件：{path}"))
}

pub fn local_asset(href: &str) -> Option<&str> {
    let href = href.split(['?', '#']).next().unwrap_or(href);
    if href.contains(':') {
        return None;
    }
    let rel = href.trim_start_matches("./").trim_start_matches('/');
    if rel.is_empty() || rel.split(['/', '\\']).any(|part| part.is_empty() || part == "." || part == "..") {
        return None;
    }
    Some(rel)
}

fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let lower = tag.to_ascii_lowercase();
    let needle = format!("{name}=");
    let mut from = 0;
    while let Some(found) = lower[from..].find(&needle) {
        let index = from + found;
        let boundary = index == 0 || lower.as_bytes()[index - 1].is_ascii_whitespace();
        if boundary {
            let rest = &tag[index + needle.len()..];
            let quote = rest.chars().next()?;
            if quote == '"' || quote == '\'' {
                let body = &rest[quote.len_utf8()..];
                let end = body.find(quote)?;
                return Some(&body[..end]);
            }
        }
        from = index + needle.len();
    }
    None
}

fn tag_name(tag: &str, name: &str) -> bool {
    let lower = tag.to_ascii_lowercase();
    let open = format!("<{name}");
    lower.starts_with(&open)
        && lower
            .as_bytes()
            .get(open.len())
            .is_some_and(|byte| byte.is_ascii_whitespace() || *byte == b'>' || *byte == b'/')
}

fn is_csp_meta(tag: &str) -> bool {
    tag_name(tag, "meta") && tag.to_ascii_lowercase().contains("content-security-policy")
}

fn is_module_preload(tag: &str) -> bool {
    tag_name(tag, "link") && attr(tag, "rel").is_some_and(|rel| rel.eq_ignore_ascii_case("modulepreload"))
}

fn is_stylesheet(tag: &str) -> bool {
    tag_name(tag, "link") && attr(tag, "rel").is_some_and(|rel| rel.eq_ignore_ascii_case("stylesheet"))
}

fn is_external_script(tag: &str) -> bool {
    tag_name(tag, "script") && attr(tag, "src").is_some()
}

fn escape_close(text: &str, closer: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = find_ignore_ascii(rest, closer) {
        out.push_str(&rest[..index]);
        out.push_str("<\\");
        out.push_str(&closer[1..]);
        rest = &rest[index + closer.len()..];
    }
    out.push_str(rest);
    out
}

fn find_ignore_ascii(text: &str, needle: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    let want = needle.as_bytes();
    if want.is_empty() || bytes.len() < want.len() {
        return None;
    }
    let last = bytes.len() - want.len();
    let mut index = 0;
    while index <= last {
        if bytes[index..index + want.len()].eq_ignore_ascii_case(want) {
            return Some(index);
        }
        index += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{assemble, local_asset};

    #[test]
    fn the_window_page_holds_its_script_and_style() {
        let html = r#"<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="script-src 'none'">
<link rel="modulepreload" href="./assets/extra.js">
<link rel="stylesheet" href="./assets/app.css">
</head><body><div id="root">正在打开 BotCamp…</div>
<script type="module" src="./assets/app.js"></script>
</body></html>"#;
        let page = assemble(html, |path| match path {
            "assets/app.css" => Some("body{color:black}</style>".into()),
            "assets/app.js" => Some("document.body.dataset.ok='1'</script>".into()),
            _ => None,
        })
        .expect("page");
        assert!(!page.to_ascii_lowercase().contains("content-security-policy"));
        assert!(!page.contains("modulepreload"));
        assert!(!page.contains("src="));
        assert!(page.contains("<style>body{color:black}<\\/style></style>"));
        assert!(page.contains("<script type=\"module\">document.body.dataset.ok='1'<\\/script></script>"));
        assert!(page.contains("正在打开 BotCamp…"));
    }

    #[test]
    fn a_page_cannot_point_outside_itself() {
        assert_eq!(local_asset("./assets/app.js"), Some("assets/app.js"));
        assert_eq!(local_asset("assets/app.js?v=1"), Some("assets/app.js"));
        assert!(local_asset("../secret.js").is_none());
        assert!(local_asset("https://example.com/app.js").is_none());
        assert!(local_asset("/assets/../app.js").is_none());
    }
}
