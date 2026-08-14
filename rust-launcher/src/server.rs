// Server child lifecycle. The supervision contract does the heavy lifting:
// we spawn `mstream-server --supervised` with a PIPED stdin we never write
// to. The server exits the moment that pipe hits EOF (src/util/supervision.js)
// — a graceful tray-Quit closes it deliberately, and ANY launcher death
// (crash, force-kill) closes it for us, so an orphan server holding the port
// is structurally impossible.
use std::fs::File;
use std::io;
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::{Duration, Instant};

pub struct ServerProc {
    pub child: Child,
    /// Held, never written. Dropping it is the shutdown signal.
    pub stdin: Option<ChildStdin>,
}

pub fn spawn(bin: &Path, server_args: &[String], log_file: &Path) -> io::Result<ServerProc> {
    let out = File::options().create(true).append(true).open(log_file)?;
    let err = out.try_clone()?;

    let mut cmd = Command::new(bin);
    cmd.args(server_args)
        .arg("--supervised")
        .stdin(Stdio::piped())
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err));

    // The macOS .app runs the LAUNCHER as its bundle executable, and
    // LaunchServices stamps __CFBundleIdentifier into our env. Drop it for
    // the child: the server is a managed background process, not the app,
    // and anything keying "launched AS the bundle" off that marker (as the
    // retired mac-app-launch.js once did) must see a plain CLI environment.
    cmd.env_remove("__CFBundleIdentifier");

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // The server is a console-subsystem exe; without this a spawn from
        // the GUI launcher flashes a console window.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn()?;
    let stdin = child.stdin.take();
    Ok(ServerProc { child, stdin })
}

/// Graceful stop: close the supervision pipe, give the server a grace
/// period to run its teardown (it reaps its own scanner/backup workers),
/// then hard-kill as a last resort.
pub fn stop(proc: &mut ServerProc, grace: Duration) {
    proc.stdin.take(); // drop = EOF = shutdown signal
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        match proc.child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(_) => return,
        }
    }
    let _ = proc.child.kill();
    let _ = proc.child.wait();
}

/// True once the endpoint answers `GET /` with something that identifies as
/// mStream. The child is ours but the PORT is not: 3000 is contested dev
/// territory, and a bare TCP connect would "succeed" instantly against a
/// squatter (React/Grafana/anything) while our child dies on EADDRINUSE
/// behind it — announcing up would then point the user's browser at a
/// stranger and mask the real boot failure. The webapp's index page carries
/// the product name; a foreign 200 won't. The endpoint's address matters as
/// much as its port: a config that pins `address` to one interface binds
/// ONLY there (server.js listen(port, address)), and probing loopback
/// against it would report a healthy server as never up — paths::read_endpoint
/// hands us the address the server will actually answer on. (SSL-terminated
/// configs won't match a plaintext GET — the launcher's whole URL surface is
/// http-only today, so such a config times out here instead of "succeeding"
/// wrong.)
pub fn wait_serving(ep: crate::paths::Endpoint, timeout: Duration) -> bool {
    let addr: SocketAddr = (ep.ip, ep.port).into();
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if probe_mstream(&addr) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    false
}

/// One probe round: HTTP GET / and check for a 200 whose payload mentions
/// mStream (the webapp title appears in the first kilobyte).
fn probe_mstream(addr: &SocketAddr) -> bool {
    use std::io::{Read, Write};
    let Ok(mut s) = TcpStream::connect_timeout(addr, Duration::from_millis(500)) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(Duration::from_millis(1500)));
    let _ = s.set_write_timeout(Some(Duration::from_millis(1500)));
    // SocketAddr's Display renders the Host form directly ([v6]:port).
    let req =
        format!("GET / HTTP/1.1\r\nHost: {addr}\r\nAccept: text/html\r\nConnection: close\r\n\r\n");
    if s.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = Vec::with_capacity(8192);
    let mut chunk = [0u8; 2048];
    while buf.len() < 16384 {
        match s.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(_) => break,
        }
    }
    let text = String::from_utf8_lossy(&buf);
    let status_ok = text
        .lines()
        .next()
        .is_some_and(|l| l.starts_with("HTTP/") && l.contains(" 200"));
    status_ok && text.contains("mStream")
}
