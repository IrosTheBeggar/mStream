// mStream p2p-sidecar — the iroh networking companion process for the
// music-discovery network.
//
// WHY A SIDECAR: mStream is Node, but the rich iroh stack (iroh-blobs
// verified transfers now, iroh-gossip for the catalog in the next phase)
// only exists in Rust — the @number0/iroh NAPI binding exposes just the
// connection layer, and n0 has deprioritized FFI parity. n0's own guidance
// is an application-specific Rust wrapper; this binary is that wrapper,
// delivered like rust-parser: per-platform prebuilt binaries in bin/,
// rebuilt + committed by CI on push to master (source-only PRs).
//
// SHAPE: a long-running child of the Node server (src/state/discovery-p2p.js),
// speaking line-delimited JSON-RPC on stdin/stdout; logs go to stderr. The
// process exits when stdin closes — the parent dying can never leave an
// orphan — or on an explicit `shutdown` command.
//
// IDENTITY: a persistent Ed25519 key at <data-dir>/identity.key, generated on
// first run. This is DELIBERATELY a separate keypair from the remote-access
// tunnel's (config.program.iroh.secretKey): the public discovery persona must
// not be linkable to the private paired-access endpoint.
//
// N1 scope: endpoint + blobs only. `publish` seeds a file (the discovery
// export snapshot) as a content-addressed blob and returns a ticket;
// `fetch` pulls a blob from the ticket's origin, BLAKE3-verified, into a
// local file. Peer exchange is manual (copy the ticket). The gossip catalog
// topic arrives in the next phase.
//
// Protocol (one JSON object per line):
//   → {"id":1,"cmd":"status"}
//   → {"id":2,"cmd":"publish","path":"C:/.../discovery-export.db"}
//   → {"id":3,"cmd":"fetch","ticket":"blob...","outDir":"C:/.../discovery-peers"}
//   → {"id":4,"cmd":"shutdown"}
//   ← {"id":N,"ok":true,...} | {"id":N,"ok":false,"error":"..."}
// plus a single unsolicited {"event":"ready",...} line once the endpoint is up.

use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use iroh::{endpoint::presets, protocol::Router, Endpoint, SecretKey};
use iroh_blobs::{store::fs::FsStore, ticket::BlobTicket, BlobsProtocol};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

#[derive(Deserialize, Debug)]
struct Request {
    id: u64,
    cmd: String,
    path: Option<String>,
    ticket: Option<String>,
    #[serde(rename = "outDir")]
    out_dir: Option<String>,
}

struct Node {
    endpoint: Endpoint,
    store: FsStore,
    router: Router,
}

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let mut data_dir: Option<PathBuf> = None;
    let mut print_id_only = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--data-dir" => data_dir = Some(PathBuf::from(args.next().context("--data-dir needs a value")?)),
            // One-shot mode for CI self-tests: create/load the identity, print
            // the endpoint id, exit. No sockets, no network.
            "--print-id" => print_id_only = true,
            other => bail!("unknown argument: {other}"),
        }
    }
    let data_dir = data_dir.context("--data-dir is required")?;
    std::fs::create_dir_all(&data_dir)
        .with_context(|| format!("creating data dir {}", data_dir.display()))?;

    if print_id_only {
        let key = load_or_create_identity(&data_dir)?;
        println!("{}", key.public());
        return Ok(());
    }

    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run(data_dir))
}

async fn run(data_dir: PathBuf) -> Result<()> {
    let key = load_or_create_identity(&data_dir)?;
    let endpoint = Endpoint::builder(presets::N0)
        .secret_key(key)
        .bind()
        .await
        .map_err(|e| anyhow!("endpoint bind failed: {e}"))?;

    let store = FsStore::load(data_dir.join("blobs"))
        .await
        .map_err(|e| anyhow!("blob store load failed: {e}"))?;
    let blobs = BlobsProtocol::new(&store, None);
    let router = Router::builder(endpoint.clone())
        .accept(iroh_blobs::ALPN, blobs)
        .spawn();

    // Bounded wait for a home relay so tickets carry relay info — mirrors the
    // awaitOnline race in src/state/iroh.js. Offline hosts proceed anyway
    // (tickets then hold direct addresses only, which still works on a LAN).
    let _ = tokio::time::timeout(Duration::from_secs(8), endpoint.online()).await;

    let node = Arc::new(Node { endpoint, store, router });

    // Single writer task owns stdout; handlers post JSON values to it. Keeps
    // concurrent responses from interleaving mid-line.
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Value>();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(v) = out_rx.recv().await {
            let mut line = v.to_string();
            line.push('\n');
            if stdout.write_all(line.as_bytes()).await.is_err() { break; }
            let _ = stdout.flush().await;
        }
    });

    out_tx.send(json!({
        "event": "ready",
        "endpointId": node.endpoint.id().to_string(),
    }))?;

    // Request loop: one line = one request; each runs as its own task so a
    // long fetch doesn't block status/shutdown. EOF on stdin = parent is gone.
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);
    loop {
        tokio::select! {
            _ = shutdown_rx.recv() => break,
            line = lines.next_line() => {
                let Some(line) = line? else { break }; // EOF
                if line.trim().is_empty() { continue; }
                let req: Request = match serde_json::from_str(&line) {
                    Ok(r) => r,
                    Err(e) => {
                        eprintln!("[p2p-sidecar] unparseable request: {e}");
                        let _ = out_tx.send(json!({"id": null, "ok": false, "error": format!("bad request: {e}")}));
                        continue;
                    }
                };
                let node = node.clone();
                let out = out_tx.clone();
                let shutdown = shutdown_tx.clone();
                tokio::spawn(async move {
                    let id = req.id;
                    let is_shutdown = req.cmd == "shutdown";
                    let result = handle(node, req).await;
                    let _ = out.send(match result {
                        Ok(mut v) => { v["id"] = json!(id); v["ok"] = json!(true); v }
                        Err(e) => json!({"id": id, "ok": false, "error": e.to_string()}),
                    });
                    if is_shutdown { let _ = shutdown.send(()).await; }
                });
            }
        }
    }

    eprintln!("[p2p-sidecar] shutting down");
    let _ = node.router.shutdown().await;
    node.endpoint.close().await;
    drop(out_tx);
    let _ = writer.await;
    Ok(())
}

async fn handle(node: Arc<Node>, req: Request) -> Result<Value> {
    match req.cmd.as_str() {
        "status" => {
            let addr = node.endpoint.addr();
            Ok(json!({
                "endpointId": node.endpoint.id().to_string(),
                "hasRelay": addr.relay_urls().next().is_some(),
            }))
        }

        "publish" => {
            let path = req.path.context("publish needs `path`")?;
            let abs = std::path::absolute(Path::new(&path))?;
            let size = tokio::fs::metadata(&abs)
                .await
                .with_context(|| format!("cannot stat {}", abs.display()))?
                .len();
            let tag = node.store.blobs().add_path(abs).await
                .map_err(|e| anyhow!("blob import failed: {e}"))?;
            let ticket = BlobTicket::new(node.endpoint.addr(), tag.hash, tag.format);
            Ok(json!({
                "hash": tag.hash.to_string(),
                "size": size,
                "ticket": ticket.to_string(),
            }))
        }

        "fetch" => {
            let ticket = BlobTicket::from_str(&req.ticket.context("fetch needs `ticket`")?)
                .map_err(|e| anyhow!("bad ticket: {e}"))?;
            let out_dir = PathBuf::from(req.out_dir.context("fetch needs `outDir`")?);
            tokio::fs::create_dir_all(&out_dir).await?;

            // Dial with the ticket's FULL EndpointAddr (relay URL + direct
            // addresses), not just the id — works on a LAN with no external
            // address lookup, and across NATs via the relay.
            let conn = node.endpoint.connect(ticket.addr().clone(), iroh_blobs::ALPN)
                .await
                .map_err(|e| anyhow!("cannot reach the ticket's origin: {e}"))?;
            node.store.remote().fetch(conn, ticket.hash_and_format()).await
                .map_err(|e| anyhow!("transfer failed: {e}"))?;

            let hash = ticket.hash();
            let out_path = out_dir.join(format!("{hash}.db"));
            node.store.blobs().export(hash, out_path.clone()).await
                .map_err(|e| anyhow!("export to file failed: {e}"))?;
            let size = tokio::fs::metadata(&out_path).await?.len();
            Ok(json!({
                "hash": hash.to_string(),
                "size": size,
                "path": out_path.to_string_lossy(),
            }))
        }

        "shutdown" => Ok(json!({})),

        other => Err(anyhow!("unknown command: {other}")),
    }
}

// Load the persistent identity key, creating it on first run. Best-effort
// 0600 on unix — the key only grants control of this node's discovery
// persona, but there's no reason to leave it group-readable.
fn load_or_create_identity(data_dir: &Path) -> Result<SecretKey> {
    let key_path = data_dir.join("identity.key");
    if key_path.exists() {
        let bytes = std::fs::read(&key_path)
            .with_context(|| format!("reading {}", key_path.display()))?;
        let arr: [u8; 32] = bytes.as_slice().try_into()
            .map_err(|_| anyhow!("{} is corrupt (expected 32 bytes, got {})", key_path.display(), bytes.len()))?;
        return Ok(SecretKey::from_bytes(&arr));
    }
    let key = SecretKey::generate();
    std::fs::write(&key_path, key.to_bytes())
        .with_context(|| format!("writing {}", key_path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600));
    }
    eprintln!("[p2p-sidecar] generated new identity at {}", key_path.display());
    Ok(key)
}
