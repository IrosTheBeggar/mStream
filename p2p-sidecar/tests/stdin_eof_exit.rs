// Regression test for the no-orphan guarantee (see the SHAPE note in
// src/main.rs): the process must exit ON ITS OWN within a bounded time of
// stdin EOF. It used to hang forever in post-loop cleanup — the stdout
// writer waited for its mpsc channel to close, but a sender clone lives
// inside the Arc<Node> shared with the never-ending gossip loops, so close
// never came and a dead parent left an orphan.
//
// Real binary, real endpoint bind (loopback UDP only — no peers, no external
// network needed). Offline hosts just eat the sidecar's bounded relay wait
// (~8s), so the budget below sits well above that but far below "forever".

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[test]
fn exits_on_stdin_eof() {
    let dir = std::env::temp_dir().join(format!("p2p-sidecar-eof-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir); // stale state from a crashed prior run
    std::fs::create_dir_all(&dir).expect("create temp data dir");

    let mut child = Command::new(env!("CARGO_BIN_EXE_p2p-sidecar"))
        .arg("--data-dir")
        .arg(&dir)
        .stdin(Stdio::null()) // immediate EOF — the "parent died" signal
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn sidecar");

    // Startup (bind + store load + up-to-8s offline relay wait) plus the
    // bounded cleanup must all fit. 30s is generous headroom for slow CI;
    // the bug this guards against was an infinite hang, not slowness.
    let deadline = Instant::now() + Duration::from_secs(30);
    let status = loop {
        if let Some(status) = child.try_wait().expect("try_wait") {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_dir_all(&dir);
            panic!("sidecar still alive 30s after stdin EOF — orphan-prevention is broken");
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let _ = std::fs::remove_dir_all(&dir);
    assert!(status.success(), "sidecar exited abnormally: {status}");
}
