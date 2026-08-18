// The Quick Connect popup: left-click the tray icon and a small always-on-top
// window appears next to it holding the pairing-code QR — scan it with the
// mStream app and you're connected. No browser, no web UI to learn first.
// (Right-click keeps the native menu, whose "Quick Connect" item still opens
// the web modal for the copy-the-code path.)
//
// Why a hand-painted window and not a native menu item: every native menu
// clamps item images to check-mark size (muda: 18px mac / 16px gtk; and
// Win32 scales hbmpItem to SM_CXMENUCHECK — measured), and a v13 QR is 69
// modules across. So it's a real window, painted as raw pixels through
// softbuffer: no toolkit, no GPU, no font stack — a QR is squares, and the
// two caption lines use a tiny embedded 5x7 bitmap font. The launcher's
// dependency graph stays small on purpose (see Cargo.toml).
//
// Where the code comes from: GET /api/v1/iroh/code on the server's loopback
// address — the SAME call the web modal makes. mayShareCode (src/api/iroh.js)
// deliberately lets a loopback caller on a fresh accountless desktop install
// have the code ("the owner's own browser, opened from the tray"); the tray
// process is that same trust position. Zero new auth surface.
use std::num::NonZeroU32;
use std::rc::Rc;
use tao::dpi::{LogicalPosition, LogicalSize, PhysicalPosition, PhysicalSize};
use tao::event_loop::EventLoopWindowTarget;
use tao::window::{Window, WindowBuilder};

/// What the popup shows. Fetched fresh on every open — the code can change
/// (config edit + restart) and Quick Connect can be off/unavailable.
pub enum Content {
    /// A pairing code to render as a QR.
    Code(String),
    /// Quick Connect is enabled but the tunnel isn't up (yet).
    NotReady,
    /// Quick Connect is disabled in the server config.
    Disabled,
    /// The server didn't answer (still booting, or stopped).
    NoServer,
}

/// Fetch the pairing code from the running server. Plain HTTP/1.1 over a
/// std TcpStream, same shape as server.rs's health probe — no HTTP crate.
/// Bounded: 1.5s per phase, so a wedged server can't freeze the tray.
pub fn fetch_content(ep: &crate::paths::Endpoint) -> Content {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;
    // ep.ip is already the PROBE address (paths.rs: a pinned interface, else
    // loopback for the wildcard default) — the same one the health prober
    // uses, so the same mayShareCode loopback trust applies.
    let addr = std::net::SocketAddr::new(ep.ip, ep.port);
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
    // Chunked bodies (Express default for JSON) come with hex length lines
    // — serde tolerates none of that, so trim to the outer braces.
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

// ── Layout (logical pixels; painted at physical size via the scale factor).
const QUIET: i32 = 3; // quiet-zone modules around the symbol
const QR_TARGET_PX: u32 = 260; // logical px the symbol+quiet zone should span
const PAD: u32 = 16;
const HEADER_H: u32 = 30;
const CAPTION_H: u32 = 44;
const BG: u32 = 0x00_FF_FF_FF;
const FG: u32 = 0x00_1A_1A_1A;
const MUTED: u32 = 0x00_6B_6B_6B;
const ACCENT: u32 = 0x00_E0_8A_00; // mStream orange

pub struct Popup {
    window: Rc<Window>,
    surface: softbuffer::Surface<Rc<Window>, Rc<Window>>,
    content: Content,
    qr: Option<qrcodegen::QrCode>,
    /// Windows click-outside detector state: set once the mouse button has
    /// been released after the opening click (see clicked_outside).
    #[cfg(windows)]
    armed: bool,
}

impl Popup {
    /// Build the window flush against the tray icon and paint it once.
    /// `icon_rect` is the tray icon's screen rectangle in PHYSICAL pixels
    /// (tray-icon's Click event carries it); `scale` converts to logical.
    pub fn open<T: 'static>(
        target: &EventLoopWindowTarget<T>,
        content: Content,
        icon_rect: Option<(PhysicalPosition<f64>, PhysicalSize<u32>)>,
    ) -> Result<Popup, String> {
        let qr = match &content {
            Content::Code(c) => qrcodegen::QrCode::encode_text(c, qrcodegen::QrCodeEcc::Medium).ok(),
            _ => None,
        };
        let (w, h) = (QR_TARGET_PX + 2 * PAD, HEADER_H + QR_TARGET_PX + CAPTION_H + PAD);
        let mut b = WindowBuilder::new()
            .with_title("mStream - Quick Connect")
            .with_inner_size(LogicalSize::new(w as f64, h as f64))
            .with_resizable(false)
            .with_always_on_top(true)
            .with_decorations(true);
        #[cfg(target_os = "macos")]
        {
            // Menu-bar-extra manners: appear without yanking focus from the
            // frontmost app or bouncing anything in the Dock.
            use tao::platform::macos::WindowBuilderExtMacOS;
            b = b.with_titlebar_transparent(false).with_title_hidden(false);
        }
        // Position: hug the tray icon, centered on it horizontally, and on
        // whichever side of it has room — the OS does NOT clamp an explicit
        // position for us (measured: a "below the icon" placement from a
        // bottom taskbar put the whole body off-screen). Below when the bar
        // is at the top (macOS menu bar, top-docked taskbars), above when
        // it's at the bottom (Windows/most Linux panels); then clamp the x
        // edges into the monitor. Physical-pixel math throughout, converted
        // to logical only for the builder.
        if let Some((pos, size)) = icon_rect {
            let mon = target
                .available_monitors()
                .find(|m| {
                    let p = m.position();
                    let s = m.size();
                    pos.x >= p.x as f64
                        && pos.x < (p.x as f64 + s.width as f64)
                        && pos.y >= p.y as f64
                        && pos.y < (p.y as f64 + s.height as f64)
                })
                .or_else(|| target.primary_monitor());
            let scale = mon.as_ref().map(|m| m.scale_factor()).unwrap_or(1.0);
            let (mon_x, mon_y, mon_w, mon_h) = mon
                .as_ref()
                .map(|m| (m.position().x as f64, m.position().y as f64, m.size().width as f64, m.size().height as f64))
                .unwrap_or((0.0, 0.0, f64::MAX, f64::MAX));
            let (pw, ph) = ((w as f64) * scale, (h as f64) * scale); // popup, physical
            let gap = 8.0 * scale;
            let icon_cx = pos.x + size.width as f64 / 2.0;
            let icon_bottom = pos.y + size.height as f64;
            let below_fits = icon_bottom + gap + ph <= mon_y + mon_h;
            let y = if below_fits { icon_bottom + gap } else { (pos.y - gap - ph).max(mon_y) };
            let x = (icon_cx - pw / 2.0).clamp(mon_x, (mon_x + mon_w - pw).max(mon_x));
            b = b.with_position(LogicalPosition::new(x / scale, y / scale));
        }
        let window = Rc::new(b.build(target).map_err(|e| format!("popup window: {e}"))?);
        let context = softbuffer::Context::new(window.clone()).map_err(|e| format!("popup context: {e}"))?;
        let surface =
            softbuffer::Surface::new(&context, window.clone()).map_err(|e| format!("popup surface: {e}"))?;
        // Take focus so that clicking anywhere else fires Focused(false) and
        // dismisses us like a real flyout. Without this a tray-spawned window
        // on Windows never becomes foreground (measured: clicks elsewhere left
        // it up); we're allowed to claim it here because this runs inside the
        // user's own click on our tray icon.
        window.set_focus();
        let mut p = Popup {
            window,
            surface,
            content,
            qr,
            #[cfg(windows)]
            armed: false,
        };
        p.paint();
        Ok(p)
    }

    /// Windows-only click-outside detection. A tray-spawned window never
    /// becomes foreground there (Windows' foreground lock refuses
    /// SetForegroundWindow while Explorer owns the click — measured: no
    /// Focused event ever arrives), so the mac/Linux "dismiss on
    /// Focused(false)" path is unreachable. Do what the OS's own flyouts do:
    /// while the popup is up, notice a primary-button press whose cursor is
    /// outside our frame. Polled from the event loop at ~50ms ONLY while a
    /// popup exists — zero cost the rest of the time.
    #[cfg(windows)]
    pub fn clicked_outside(&mut self) -> bool {
        use windows_sys::Win32::Foundation::POINT;
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
        use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
        // GetAsyncKeyState: high bit = down right now; LOW bit = "was
        // pressed since the last call" — a latch, so a click shorter than
        // our 50ms poll interval can't slip between two polls (a fast click
        // is down for ~10ms; measured: the pure high-bit test missed some).
        let l = unsafe { GetAsyncKeyState(VK_LBUTTON as i32) } as u16;
        let r = unsafe { GetAsyncKeyState(VK_RBUTTON as i32) } as u16;
        let down_now = (l | r) & 0x8000 != 0;
        let pressed_since = (l | r) & 0x0001 != 0;
        // The click that OPENED us is itself "outside" (it's on the tray
        // icon), and its press may still be latched/held on our first poll:
        // arm only once we've observed the button fully released, and drain
        // the latch as we do so.
        if !self.armed {
            if !down_now {
                self.armed = true;
            }
            return false;
        }
        if !down_now && !pressed_since {
            return false;
        }
        let mut pt = POINT { x: 0, y: 0 };
        if unsafe { GetCursorPos(&mut pt) } == 0 {
            return false;
        }
        let (Ok(pos), size) = (self.window.outer_position(), self.window.outer_size()) else {
            return false;
        };
        let inside = pt.x >= pos.x
            && pt.x < pos.x + size.width as i32
            && pt.y >= pos.y
            && pt.y < pos.y + size.height as i32;
        !inside
    }

    pub fn window_id(&self) -> tao::window::WindowId {
        self.window.id()
    }

    pub fn request_redraw(&self) {
        self.window.request_redraw();
    }

    /// Paint the whole surface. Everything is integer pixel math on a flat
    /// 0RGB buffer — deliberately dumb and dependency-free.
    pub fn paint(&mut self) {
        let size = self.window.inner_size();
        let (pw, ph) = (size.width as usize, size.height as usize);
        let (Some(nw), Some(nh)) = (NonZeroU32::new(pw as u32), NonZeroU32::new(ph as u32)) else {
            return;
        };
        if self.surface.resize(nw, nh).is_err() {
            return;
        }
        let Ok(mut buf) = self.surface.buffer_mut() else { return };
        let scale = self.window.scale_factor();
        let px = |logical: u32| ((logical as f64) * scale).round() as usize;
        let mut c = Canvas { buf: &mut buf, w: pw, h: ph };
        c.fill(BG);

        // Header: accent rule + title.
        c.rect(0, 0, pw, px(3), ACCENT);
        let title_scale = if scale >= 1.5 { 3 } else { 2 };
        c.text_centered(pw, px(9), "mStream Quick Connect", FG, title_scale);

        let qr_top = px(HEADER_H);
        let qr_left = px(PAD);
        let qr_side = px(QR_TARGET_PX);
        match (&self.content, &self.qr) {
            (Content::Code(_), Some(qr)) => {
                let modules = qr.size() + 2 * QUIET;
                let cell = (qr_side / modules as usize).max(1);
                let drawn = cell * modules as usize;
                let off = (qr_side.saturating_sub(drawn)) / 2; // center the integer-cell symbol
                for my in -QUIET..(qr.size() + QUIET) {
                    for mx in -QUIET..(qr.size() + QUIET) {
                        if qr.get_module(mx, my) {
                            let x = qr_left + off + ((mx + QUIET) as usize) * cell;
                            let y = qr_top + off + ((my + QUIET) as usize) * cell;
                            c.rect(x, y, cell, cell, FG);
                        }
                    }
                }
                let cap_y = qr_top + qr_side + px(10);
                c.text_centered(pw, cap_y, "Scan with the mStream app", FG, 2);
                c.text_centered(pw, cap_y + px(18), "Right-click icon for menu", MUTED, 1);
            }
            _ => {
                // State card in place of the symbol.
                c.rect_outline(qr_left, qr_top, qr_side, qr_side, MUTED);
                // Lines sized to fit the 260px card at 2x/1x (5x7 font, 6px
                // advance): <= 21 chars at 2x, <= 42 at 1x.
                let (l1, l2, l3) = match self.content {
                    Content::NotReady => ("Quick Connect starting", "The tunnel isn't up yet.", "Try again in a moment."),
                    Content::Disabled => ("Quick Connect is off", "Turn it on in the admin panel", "or scan the LAN in the app."),
                    Content::NoServer | Content::Code(_) => ("Server not answering", "It may still be starting.", "See View logs in the menu."),
                };
                let mid = qr_top + qr_side / 2;
                c.text_centered(pw, mid - px(18), l1, FG, 2);
                c.text_centered(pw, mid + px(4), l2, MUTED, 1);
                c.text_centered(pw, mid + px(14), l3, MUTED, 1);
            }
        }
        let _ = buf.present();
    }
}

/// Minimal raster helpers over the softbuffer pixel slice.
struct Canvas<'a> {
    buf: &'a mut [u32],
    w: usize,
    h: usize,
}

impl Canvas<'_> {
    fn fill(&mut self, color: u32) {
        self.buf.fill(color);
    }
    fn rect(&mut self, x: usize, y: usize, w: usize, h: usize, color: u32) {
        for yy in y..(y + h).min(self.h) {
            let row = yy * self.w;
            for xx in x..(x + w).min(self.w) {
                self.buf[row + xx] = color;
            }
        }
    }
    fn rect_outline(&mut self, x: usize, y: usize, w: usize, h: usize, color: u32) {
        self.rect(x, y, w, 1, color);
        self.rect(x, y + h - 1, w, 1, color);
        self.rect(x, y, 1, h, color);
        self.rect(x + w - 1, y, 1, h, color);
    }
    /// Text centered horizontally in a `width`-px row.
    fn text_centered(&mut self, width: usize, y: usize, s: &str, color: u32, scale: usize) {
        let text_w = s.chars().count() * 6 * scale;
        let x = width.saturating_sub(text_w) / 2;
        self.text(x, y, s, color, scale);
    }
    /// 5x7 bitmap text at an integer scale; unknown chars render as space.
    fn text(&mut self, x: usize, y: usize, s: &str, color: u32, scale: usize) {
        let mut cx = x;
        for ch in s.chars() {
            let glyph = font5x7(ch);
            for (row, bits) in glyph.iter().enumerate() {
                for col in 0..5 {
                    if bits & (0b10000 >> col) != 0 {
                        self.rect(cx + col * scale, y + row * scale, scale, scale, color);
                    }
                }
            }
            cx += 6 * scale;
        }
    }
}

/// A 5x7 font for the handful of caption strings above. Each glyph is seven
/// rows of five bits, MSB = leftmost column. Printable ASCII subset that the
/// captions use; anything else is a blank cell. (Classic public-domain
/// 5x7 shapes as used by countless LCD/LED libraries.)
fn font5x7(ch: char) -> [u8; 7] {
    match ch {
        'A' => [0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
        'B' => [0x1E, 0x11, 0x11, 0x1E, 0x11, 0x11, 0x1E],
        'C' => [0x0E, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0E],
        'D' => [0x1E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1E],
        'E' => [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F],
        'F' => [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x10],
        'G' => [0x0E, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0F],
        'H' => [0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
        'I' => [0x0E, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E],
        'J' => [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0C],
        'K' => [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
        'L' => [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1F],
        'M' => [0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11],
        'N' => [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11],
        'O' => [0x0E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
        'P' => [0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10],
        'Q' => [0x0E, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0D],
        'R' => [0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11],
        'S' => [0x0F, 0x10, 0x10, 0x0E, 0x01, 0x01, 0x1E],
        'T' => [0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
        'U' => [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
        'V' => [0x11, 0x11, 0x11, 0x11, 0x11, 0x0A, 0x04],
        'W' => [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0A],
        'X' => [0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11],
        'Y' => [0x11, 0x11, 0x11, 0x0A, 0x04, 0x04, 0x04],
        'Z' => [0x1F, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1F],
        'a' => [0x00, 0x00, 0x0E, 0x01, 0x0F, 0x11, 0x0F],
        'b' => [0x10, 0x10, 0x16, 0x19, 0x11, 0x11, 0x1E],
        'c' => [0x00, 0x00, 0x0E, 0x10, 0x10, 0x11, 0x0E],
        'd' => [0x01, 0x01, 0x0D, 0x13, 0x11, 0x11, 0x0F],
        'e' => [0x00, 0x00, 0x0E, 0x11, 0x1F, 0x10, 0x0E],
        'f' => [0x06, 0x09, 0x08, 0x1C, 0x08, 0x08, 0x08],
        'g' => [0x00, 0x0F, 0x11, 0x11, 0x0F, 0x01, 0x0E],
        'h' => [0x10, 0x10, 0x16, 0x19, 0x11, 0x11, 0x11],
        'i' => [0x04, 0x00, 0x0C, 0x04, 0x04, 0x04, 0x0E],
        'j' => [0x02, 0x00, 0x06, 0x02, 0x02, 0x12, 0x0C],
        'k' => [0x10, 0x10, 0x12, 0x14, 0x18, 0x14, 0x12],
        'l' => [0x0C, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E],
        'm' => [0x00, 0x00, 0x1A, 0x15, 0x15, 0x11, 0x11],
        'n' => [0x00, 0x00, 0x16, 0x19, 0x11, 0x11, 0x11],
        'o' => [0x00, 0x00, 0x0E, 0x11, 0x11, 0x11, 0x0E],
        'p' => [0x00, 0x00, 0x1E, 0x11, 0x1E, 0x10, 0x10],
        'q' => [0x00, 0x00, 0x0D, 0x13, 0x0F, 0x01, 0x01],
        'r' => [0x00, 0x00, 0x16, 0x19, 0x10, 0x10, 0x10],
        's' => [0x00, 0x00, 0x0E, 0x10, 0x0E, 0x01, 0x1E],
        't' => [0x08, 0x08, 0x1C, 0x08, 0x08, 0x09, 0x06],
        'u' => [0x00, 0x00, 0x11, 0x11, 0x11, 0x13, 0x0D],
        'v' => [0x00, 0x00, 0x11, 0x11, 0x11, 0x0A, 0x04],
        'w' => [0x00, 0x00, 0x11, 0x11, 0x15, 0x15, 0x0A],
        'x' => [0x00, 0x00, 0x11, 0x0A, 0x04, 0x0A, 0x11],
        'y' => [0x00, 0x00, 0x11, 0x11, 0x0F, 0x01, 0x0E],
        'z' => [0x00, 0x00, 0x1F, 0x02, 0x04, 0x08, 0x1F],
        '0' => [0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E],
        '1' => [0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E],
        '2' => [0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F],
        '3' => [0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E],
        '4' => [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02],
        '5' => [0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E],
        '6' => [0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E],
        '7' => [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
        '8' => [0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E],
        '9' => [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C],
        '-' => [0x00, 0x00, 0x00, 0x1F, 0x00, 0x00, 0x00],
        '\'' => [0x0C, 0x04, 0x08, 0x00, 0x00, 0x00, 0x00],
        ',' => [0x00, 0x00, 0x00, 0x00, 0x0C, 0x04, 0x08],
        '.' => [0x00, 0x00, 0x00, 0x00, 0x00, 0x0C, 0x0C],
        '>' => [0x08, 0x04, 0x02, 0x01, 0x02, 0x04, 0x08],
        _ => [0; 7],
    }
}
