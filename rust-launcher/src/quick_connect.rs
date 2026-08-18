// The tray "Quick Connect" item: open a terminal window holding the pairing-
// code QR and a short explanation, so a phone can scan it and reach this
// server over the Iroh tunnel — no browser, no port forwarding, no network
// setup.
//
// How it renders: the tray re-invokes THIS launcher binary as
// `--show-quick-connect=<ip:port>` inside a fresh terminal (platform.rs opens
// it per-OS). That subcommand fetches the code from the running server on
// loopback — GET /api/v1/iroh/code, the same endpoint the web modal uses;
// mayShareCode (src/api/iroh.js) grants a loopback caller on a fresh
// accountless desktop install — and paints the QR as raw half-block
// characters with EXPLICIT colours, so the terminal's own theme can't invert
// the symbol. qrcodegen is the Rust port of the same Nayuki library
// webapp/assets/js/lib/qr.js uses, so the terminal and the web modal encode
// an identical code.
//
// Rendering in-process (not a shell script printing a file) is deliberate: a
// pre-coloured file shown with `type`/`cat` renders the ANSI escapes as
// garbage on a Windows console that hasn't opted into VT, and the shipped
// bundle can't assume `node` is present. The launcher binary is always
// there, so it prints the code itself — enabling VT + UTF-8 and sizing its
// own window along the way.

use std::net::SocketAddr;
use std::time::Duration;

/// What the terminal shows: a scannable code, or why there isn't one.
enum Content {
    /// A pairing code to render as a QR.
    Code(String),
    /// Quick Connect is enabled but the tunnel isn't up yet.
    NotReady,
    /// Quick Connect is disabled in the server config.
    Disabled,
    /// The server didn't answer (still booting, or stopped).
    NoServer,
}

/// Quiet-zone modules around the symbol (the QR spec's minimum is 4).
const QUIET: i32 = 4;

/// `--show-quick-connect=<addr>` entry point: fetch, render, print into the
/// terminal we were spawned in, wait for Enter, exit. Returns the exit code.
pub fn show(addr_str: &str) -> i32 {
    let content = match addr_str.parse::<SocketAddr>() {
        Ok(addr) => fetch(addr),
        Err(_) => Content::NoServer,
    };
    let (body, cols, rows) = render(&content);
    print_and_wait(&body, cols, rows);
    0
}

// ── Fetch the pairing code from the running server. Plain HTTP/1.1 over a
// std TcpStream, same shape as server.rs's health probe — no HTTP crate.
// Bounded timeouts so a wedged server can't freeze the window.
fn fetch(addr: SocketAddr) -> Content {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(1500)) else {
        return Content::NoServer;
    };
    let _ = s.set_read_timeout(Some(Duration::from_millis(1500)));
    let _ = s.set_write_timeout(Some(Duration::from_millis(1500)));
    let req = format!(
        "GET /api/v1/iroh/code HTTP/1.1\r\nHost: {addr}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    if s.write_all(req.as_bytes()).is_err() {
        return Content::NoServer;
    }
    let mut buf = Vec::with_capacity(4096);
    let _ = s.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    let Some((head, body)) = text.split_once("\r\n\r\n") else {
        return Content::NoServer;
    };
    if !head.lines().next().is_some_and(|l| l.contains(" 200")) {
        return Content::NoServer;
    }
    // Chunked bodies (Express default for JSON) carry hex length lines serde
    // won't parse — trim to the outer braces.
    let json = match (body.find('{'), body.rfind('}')) {
        (Some(a), Some(b)) if b >= a => &body[a..=b],
        _ => return Content::NoServer,
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else {
        return Content::NoServer;
    };
    if v.get("enabled").and_then(|e| e.as_bool()) != Some(true) {
        return Content::Disabled;
    }
    match v.get("code").and_then(|c| c.as_str()) {
        Some(code) if !code.is_empty() => Content::Code(code.to_string()),
        _ => Content::NotReady,
    }
}

// ── Render. ANSI truecolor: dark modules black, light + quiet zone white,
// ALWAYS painted so a dark terminal theme can't invert the symbol.
const FG_BLACK: &str = "\x1b[38;2;0;0;0m";
const FG_WHITE: &str = "\x1b[38;2;255;255;255m";
const BG_BLACK: &str = "\x1b[48;2;0;0;0m";
const BG_WHITE: &str = "\x1b[48;2;255;255;255m";
const RESET: &str = "\x1b[0m";
const INDENT: &str = "  ";

/// Returns (body with CRLF line breaks, visible columns, rows). No resize
/// escape or sizing here — the printer applies both.
fn render(content: &Content) -> (String, u16, u16) {
    let mut lines: Vec<String> = Vec::new();
    let mut width: usize = 0;
    let push = |lines: &mut Vec<String>, width: &mut usize, s: &str, visible: usize| {
        *width = (*width).max(visible);
        lines.push(s.to_string());
    };

    // Header + explanation — the same for every state.
    for h in [
        "mStream Quick Connect",
        "",
        "Scan this QR code with the mStream mobile app to reach this",
        "server from anywhere - no port forwarding, no network setup.",
        "In the app:  Add Server  >  Quick Connect  >  Scan",
        "",
    ] {
        let line = if h.is_empty() { String::new() } else { format!("{INDENT}{h}") };
        push(&mut lines, &mut width, &line, line.chars().count());
    }

    match content {
        Content::Code(code) => match qrcodegen::QrCode::encode_text(code, qrcodegen::QrCodeEcc::Medium) {
            Ok(qr) => {
                let cols = push_qr(&mut lines, &qr);
                width = width.max(cols);
            }
            // A valid pairing code always encodes; treat the impossible case
            // as "not ready" rather than a blank window.
            Err(_) => push_state(&mut lines, &mut width, &Content::NotReady),
        },
        other => push_state(&mut lines, &mut width, other),
    }

    // Footer.
    let footer: &[&str] = match content {
        Content::Code(_) => &[
            "",
            "This code is a private pairing key for THIS server - anyone who",
            "scans it can reach your library. Don't share or post it.",
            "",
            "Press Enter to close this window.",
        ],
        _ => &["", "Press Enter to close this window."],
    };
    for f in footer {
        let line = if f.is_empty() { String::new() } else { format!("{INDENT}{f}") };
        push(&mut lines, &mut width, &line, line.chars().count());
    }

    let rows = lines.len() as u16;
    (lines.join("\r\n"), width as u16, rows)
}

/// The centered state message when there's no code to show.
fn push_state(lines: &mut Vec<String>, width: &mut usize, content: &Content) {
    let msg: &[&str] = match content {
        Content::NotReady => &[
            "Quick Connect is starting up - the secure tunnel isn't ready yet.",
            "Wait a few seconds, then open Quick Connect again.",
        ],
        Content::Disabled => &[
            "Quick Connect is turned off for this server.",
            "Turn it on in the admin settings, then try again.",
        ],
        // NoServer, and the unreachable Code arm.
        _ => &[
            "The mStream server isn't answering yet.",
            "It may still be starting - try again in a moment.",
        ],
    };
    for m in msg {
        let line = format!("{INDENT}{m}");
        *width = (*width).max(line.chars().count());
        lines.push(line);
    }
}

/// Paint the QR as half-block rows (`▀`: fg = the upper module, bg = the
/// lower module, so one character row is two module rows). Colour codes are
/// emitted only when they change across a row — the runs in a QR keep the
/// escape volume small. Returns the column count (symbol + quiet zone).
fn push_qr(lines: &mut Vec<String>, qr: &qrcodegen::QrCode) -> usize {
    let n = qr.size();
    let dark = |x: i32, y: i32| x >= 0 && y >= 0 && x < n && y < n && qr.get_module(x, y);
    let total = (n + 2 * QUIET) as usize;
    let mut my = -QUIET;
    while my < n + QUIET {
        let mut line = String::new();
        let mut cur_fg: Option<bool> = None; // true = black
        let mut cur_bg: Option<bool> = None;
        for mx in -QUIET..(n + QUIET) {
            let top = dark(mx, my);
            let bot = my + 1 < n + QUIET && dark(mx, my + 1);
            if cur_fg != Some(top) {
                line.push_str(if top { FG_BLACK } else { FG_WHITE });
                cur_fg = Some(top);
            }
            if cur_bg != Some(bot) {
                line.push_str(if bot { BG_BLACK } else { BG_WHITE });
                cur_bg = Some(bot);
            }
            line.push('\u{2580}'); // ▀ UPPER HALF BLOCK
        }
        line.push_str(RESET);
        lines.push(line);
        my += 2;
    }
    total
}

// ── Print + wait. The subcommand runs in a terminal we were spawned into;
// size it to fit, paint, then block until Enter so the window stays up.

#[cfg(unix)]
fn print_and_wait(body: &str, cols: u16, rows: u16) {
    use std::io::{Read, Write};
    let mut out = std::io::stdout();
    // Resize the terminal to fit (xterm, VTE/gnome-terminal, konsole and
    // Terminal.app all honour the window-manipulation escape); then clear.
    let _ = write!(out, "\x1b[8;{};{}t\x1b[2J\x1b[H", rows + 2, cols + 2);
    let _ = out.write_all(body.as_bytes());
    let _ = out.write_all(b"\r\n");
    let _ = out.flush();
    let mut b = [0u8; 1];
    let _ = std::io::stdin().read(&mut b); // wait for Enter
}

#[cfg(windows)]
fn print_and_wait(body: &str, cols: u16, rows: u16) {
    use std::io::{Read, Write};
    use std::os::windows::io::AsRawHandle;
    // GUI-subsystem exe + CREATE_NEW_CONSOLE leaves the std handles NULL, but
    // the fresh console IS attached — open its devices directly, the same
    // trick platform::run_console_passthrough uses.
    let out = std::fs::File::options().read(true).write(true).open("CONOUT$").ok();
    let inp = std::fs::File::options().read(true).write(true).open("CONIN$").ok();
    if let Some(mut out) = out {
        win_setup(out.as_raw_handle(), cols, rows);
        // Also emit the VT resize escape: Windows Terminal (the Win11 default
        // host) honours it even where the console-buffer API doesn't move its
        // window.
        let s = format!("\x1b[8;{};{}t\x1b[2J\x1b[H{body}\r\n", rows + 2, cols + 2);
        // Chunk on char boundaries — a single giant WriteFile to a CP_UTF8
        // console can drop the tail.
        let bytes = s.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            let mut e = (i + 4096).min(bytes.len());
            while e > i && !s.is_char_boundary(e) {
                e -= 1;
            }
            if out.write_all(&bytes[i..e]).is_err() {
                break;
            }
            i = e;
        }
        let _ = out.flush();
    }
    if let Some(mut inp) = inp {
        let mut b = [0u8; 1];
        let _ = inp.read(&mut b); // cooked console input: returns on Enter
    }
}

/// Enable UTF-8 + VT on the new console and grow its window to fit the QR.
#[cfg(windows)]
fn win_setup(handle: std::os::windows::io::RawHandle, cols: u16, rows: u16) {
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::Console::{
        GetConsoleMode, GetLargestConsoleWindowSize, SetConsoleMode, SetConsoleOutputCP,
        SetConsoleScreenBufferSize, SetConsoleWindowInfo, COORD,
        ENABLE_VIRTUAL_TERMINAL_PROCESSING, SMALL_RECT,
    };
    let h = handle as HANDLE;
    unsafe {
        SetConsoleOutputCP(65001); // CP_UTF8 so the ▀ bytes render, not mojibake
        let mut mode = 0u32;
        if GetConsoleMode(h, &mut mode) != 0 {
            SetConsoleMode(h, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
        }
        // Clamp to what the display can host, then the classic "shrink the
        // window to 1x1 so the buffer can be resized freely, size the buffer,
        // grow the window to match" recipe — buffer == window, no scrollbars,
        // and it works from any starting size. Best-effort throughout.
        let largest = GetLargestConsoleWindowSize(h);
        let mut want_cols = cols.saturating_add(2);
        let mut want_rows = rows.saturating_add(2);
        if largest.X > 0 {
            want_cols = want_cols.min(largest.X as u16);
        }
        if largest.Y > 0 {
            want_rows = want_rows.min(largest.Y as u16);
        }
        let min = SMALL_RECT { Left: 0, Top: 0, Right: 0, Bottom: 0 };
        SetConsoleWindowInfo(h, 1, &min);
        SetConsoleScreenBufferSize(h, COORD { X: want_cols as i16, Y: want_rows as i16 });
        let rect = SMALL_RECT { Left: 0, Top: 0, Right: want_cols as i16 - 1, Bottom: want_rows as i16 - 1 };
        SetConsoleWindowInfo(h, 1, &rect);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A real pairing code is ~322 chars (EndpointTicket + secret) -> QR v13,
    // 69 modules, 77 columns with the quiet zone. This stand-in is that long.
    fn sample_code() -> String {
        format!("mstr1:{}", "A".repeat(316))
    }

    #[test]
    fn code_renders_a_qr_sized_to_fit() {
        let (body, cols, rows) = render(&Content::Code(sample_code()));
        assert!(body.contains('\u{2580}'), "QR uses the half-block glyph");
        assert!(body.contains("mStream Quick Connect"), "keeps the header");
        assert!(body.contains("Press Enter"), "keeps the footer");
        // v13 symbol + quiet zone = 77 columns; header/footer text is narrower.
        assert_eq!(cols, 77, "width is the QR width, not the prose");
        // Half-block QR is 39 rows; plus header (6) + footer (5) = 50.
        assert_eq!(rows, 50);
        // Every logical line is present and CRLF-joined.
        assert_eq!(body.split("\r\n").count(), rows as usize);
    }

    #[test]
    fn states_render_prose_not_a_qr() {
        for (content, needle) in [
            (Content::NotReady, "starting up"),
            (Content::Disabled, "turned off"),
            (Content::NoServer, "isn't answering"),
        ] {
            let (body, cols, rows) = render(&content);
            assert!(body.contains(needle), "{needle} message present");
            assert!(!body.contains('\u{2580}'), "no QR glyph in a state card");
            assert!(rows > 0 && cols > 0);
        }
    }

    #[test]
    fn colours_are_always_explicit_so_a_dark_theme_cannot_invert() {
        let (body, _, _) = render(&Content::Code(sample_code()));
        assert!(body.contains(BG_WHITE), "light modules paint an explicit white ground");
        assert!(body.contains(FG_BLACK), "dark modules paint explicit black");
        assert!(body.contains(RESET), "each row resets the colours");
    }
}
