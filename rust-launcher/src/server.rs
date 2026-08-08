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

    // The macOS .app will run the LAUNCHER as its bundle executable, and
    // LaunchServices stamps __CFBundleIdentifier into our env. The server
    // child must not inherit it: server-side code keys "launched AS the
    // bundle" off that marker (see #803's mac-app-launch), and the child is
    // a managed background process, not the app.
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

/// True once something accepts TCP on the port. Identity isn't in question
/// — the child is OURS — this only answers "is it up yet".
pub fn wait_listening(port: u16, timeout: Duration) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    false
}
