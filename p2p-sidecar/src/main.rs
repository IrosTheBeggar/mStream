// mStream p2p-sidecar — the iroh networking companion process for the
// music-discovery network.
//
// WHY A SIDECAR: mStream is Node, but the rich iroh stack (iroh-blobs
// verified transfers, iroh-gossip for the catalog) only exists in Rust —
// the @number0/iroh NAPI binding exposes just the connection layer, and n0
// has deprioritized FFI parity. n0's own guidance is an
// application-specific Rust wrapper; this binary is that wrapper,
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
// N1 (blobs): `publish` seeds a file (the discovery export snapshot) as a
// content-addressed blob and returns a ticket; `fetch` pulls a blob —
// BLAKE3-verified — into a local file, from a ticket or from {hash, provider}.
//
// N2 (gossip catalog): `join` subscribes to the well-known catalog topic
// (bootstrap = endpoint tickets or bare ids); `announce` broadcasts a
// SIGNED snapshot announcement and keeps re-broadcasting it periodically
// (gossip has no history/replay — late joiners only hear periodic
// re-announcements). Incoming announcements are signature-verified and
// rate-limited here, then forwarded to Node as unsolicited events; the
// catalog itself lives on the Node side. Signing is mandatory because a
// gossip Message's `delivered_from` is the last hop, NOT the author —
// without app-level signatures any peer could impersonate any other.
//
// Protocol (one JSON object per line):
//   → {"id":1,"cmd":"status"}
//   → {"id":2,"cmd":"publish","path":"C:/.../discovery-export.db"}
//   → {"id":3,"cmd":"fetch","ticket":"blob...","outDir":"C:/.../discovery-peers"}
//   → {"id":4,"cmd":"fetch","hash":"<64 hex>","provider":"<endpoint id>","outDir":"..."}
//   → {"id":5,"cmd":"join","bootstrap":["<endpoint ticket | endpoint id>",...]}
//   → {"id":6,"cmd":"announce","payload":{"hash":"...","size":1,"rowCount":1,
//        "modelId":"...","modelVersion":"...","snapshotSeq":1,"name":"..."}}
//   → {"id":7,"cmd":"shutdown"}
//   ← {"id":N,"ok":true,...} | {"id":N,"ok":false,"error":"..."}
// Unsolicited events:
//   ← {"event":"ready","endpointId":"...","ticket":"..."}
//   ← {"event":"announcement","from":"...","payload":{...}}
//   ← {"event":"neighbor","up":true|false,"id":"..."}

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use iroh::{
    address_lookup::memory::MemoryLookup, endpoint::presets, protocol::Router, Endpoint,
    EndpointId, PublicKey, SecretKey, Signature,
};
use iroh_blobs::{
    store::fs::{options::Options as StoreOptions, FsStore},
    store::GcConfig,
    ticket::BlobTicket, BlobsProtocol, Hash,
};
use iroh_gossip::{
    api::{Event, GossipReceiver, GossipSender},
    net::Gossip,
    proto::TopicId,
};
use iroh_tickets::endpoint::EndpointTicket;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, Mutex};

// The well-known catalog topic. Deriving it from a versioned string means a
// future incompatible announcement format simply moves to .../v2 — old and
// new nodes stop hearing each other instead of choking on each other.
const CATALOG_TOPIC: &[u8] = b"mstream/discovery/catalog/v1";

// Gossip delivers no history: re-broadcast the current announcement on an
// interval so late joiners hear about us within one period.
const ANNOUNCE_INTERVAL: Duration = Duration::from_secs(15);
// Ignore announcements from the same origin arriving faster than this — a
// well-behaved peer re-announces every ANNOUNCE_INTERVAL, so anything much
// faster is a flood.
const MIN_ANNOUNCE_GAP: Duration = Duration::from_secs(5);
const MAX_ANNOUNCEMENT_BYTES: usize = 2048;
const SIGNING_CONTEXT: &str = "mstream-discovery-announce-v1";
// Holds beacons: each node periodically broadcasts the snapshot hashes it
// currently HOLDS (its own + fetched shelf). Receivers aggregate them into
// hash -> holders, which yields (a) live seeder counts — the honest
// popularity signal a decentralized network can actually observe — and
// (b) alternative providers for multi-source fetch.
const HOLDS_INTERVAL: Duration = Duration::from_secs(60);
const HOLDS_SIGNING_CONTEXT: &str = "mstream-discovery-holds-v1";
const MAX_HOLDS: usize = 64;
const MAX_HOLDS_BYTES: usize = 8192;

#[derive(Deserialize, Debug)]
struct Request {
    id: u64,
    cmd: String,
    path: Option<String>,
    ticket: Option<String>,
    hash: Option<String>,
    provider: Option<String>,
    providers: Option<Vec<String>>,
    #[serde(rename = "outDir")]
    out_dir: Option<String>,
    bootstrap: Option<Vec<String>>,
    payload: Option<AnnouncePayload>,
    hashes: Option<Vec<String>>,
}

// What a server says about its current snapshot. `snapshot_seq` is the
// app-managed monotonic counter from discovery_meta.row_seq — receivers keep
// the highest-seq announcement per origin, so a replayed older announcement
// can never roll a catalog entry back (wall clocks are not monotonic; the
// counter is).
#[derive(Serialize, Deserialize, Debug, Clone)]
struct AnnouncePayload {
    hash: String,
    size: u64,
    #[serde(rename = "rowCount")]
    row_count: u64,
    #[serde(rename = "modelId")]
    model_id: String,
    #[serde(rename = "modelVersion")]
    model_version: String,
    #[serde(rename = "snapshotSeq")]
    snapshot_seq: u64,
    #[serde(default)]
    name: String,
}

// Holds beacon wire form (kind:"holds"). Signed like announcements — the
// holder list is a claim about WHO HAS WHAT, exactly the thing an attacker
// would want to inflate, so it gets the same origin-signature treatment.
#[derive(Serialize, Deserialize, Debug, Clone)]
struct HoldsBeacon {
    v: u32,
    kind: String,
    from: String,
    holds: Vec<String>,
    sig: String,
    #[serde(default)]
    n: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct Announcement {
    v: u32,
    from: String,
    payload: AnnouncePayload,
    sig: String,
    // Heartbeat counter, bumped on every re-broadcast and deliberately NOT
    // part of the signature. Gossip (Plumtree) deduplicates by message
    // content, so byte-identical re-broadcasts are silently dropped — late
    // joiners would never hear us and receivers' last-heard timestamps (the
    // "online" indicator) would never refresh. The counter makes each
    // heartbeat unique bytes. Replaying with a fresh counter buys an
    // attacker nothing: the payload is still signed, snapshotSeq still
    // can't roll back, and the per-origin rate limit caps processing.
    #[serde(default)]
    n: u64,
}

struct Node {
    endpoint: Endpoint,
    store: FsStore,
    #[allow(dead_code)] // held for its Drop side (accept loop shutdown)
    router: Router,
    gossip: Gossip,
    memory_lookup: MemoryLookup,
    secret_key: SecretKey,
    // Some(sender) once `join` has run; join_peers() feeds later bootstrap adds.
    topic_sender: Mutex<Option<GossipSender>>,
    // The signed announcement the announcer loop re-broadcasts (with a fresh
    // heartbeat counter per send — see Announcement::n).
    current_announcement: Mutex<Option<Announcement>>,
    // The snapshot hashes this node currently holds (own + fetched shelf),
    // sorted — beaconed periodically by the holds loop.
    current_holds: Mutex<Vec<String>>,
    heartbeat: std::sync::atomic::AtomicU64,
    // Live direct neighbors on the catalog topic (from NeighborUp/Down).
    neighbor_count: AtomicI64,
    // "kind:origin" -> (last accepted instant, seq/marker). Flood guard:
    // same-content heartbeats coalesce, genuinely-new content passes.
    last_accepted: Mutex<HashMap<String, (Instant, u64)>>,
    out_tx: mpsc::UnboundedSender<Value>,
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
    // MemoryLookup lets `join`/`fetch` seed full addresses from tickets, so
    // bootstrap works LAN-local (and in tests) without any external address
    // lookup; the N0 preset still provides relay + DNS discovery on top.
    let memory_lookup = MemoryLookup::new();
    let endpoint = Endpoint::builder(presets::N0)
        .secret_key(key.clone())
        .address_lookup(memory_lookup.clone())
        .bind()
        .await
        .map_err(|e| anyhow!("endpoint bind failed: {e}"))?;

    // GC on: `forget` unpins a blob's tags and the collector reclaims the
    // bytes on its next pass. Without this, every replaced snapshot (ours on
    // re-publish, peers' on refresh) would sit in the store forever.
    let blobs_root = data_dir.join("blobs");
    let mut store_opts = StoreOptions::new(&blobs_root);
    store_opts.gc = Some(GcConfig { interval: Duration::from_secs(15 * 60), add_protected: None });
    let store = FsStore::load_with_opts(blobs_root.join("blobs.db"), store_opts)
        .await
        .map_err(|e| anyhow!("blob store load failed: {e}"))?;
    let blobs = BlobsProtocol::new(&store, None);
    let gossip = Gossip::builder().spawn(endpoint.clone());
    let router = Router::builder(endpoint.clone())
        .accept(iroh_blobs::ALPN, blobs)
        .accept(iroh_gossip::ALPN, gossip.clone())
        .spawn();

    // Bounded wait for a home relay so tickets carry relay info — mirrors the
    // awaitOnline race in src/state/iroh.js. Offline hosts proceed anyway
    // (tickets then hold direct addresses only, which still works on a LAN).
    let _ = tokio::time::timeout(Duration::from_secs(8), endpoint.online()).await;

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

    let node = Arc::new(Node {
        endpoint,
        store,
        router,
        gossip,
        memory_lookup,
        secret_key: key,
        topic_sender: Mutex::new(None),
        current_announcement: Mutex::new(None),
        current_holds: Mutex::new(Vec::new()),
        heartbeat: std::sync::atomic::AtomicU64::new(0),
        neighbor_count: AtomicI64::new(0),
        last_accepted: Mutex::new(HashMap::new()),
        out_tx: out_tx.clone(),
    });

    out_tx.send(json!({
        "event": "ready",
        "endpointId": node.endpoint.id().to_string(),
        "ticket": endpoint_ticket(&node),
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
                "ticket": endpoint_ticket(&node),
                "joined": node.topic_sender.lock().await.is_some(),
                "neighbors": node.neighbor_count.load(Ordering::Relaxed).max(0),
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
            let out_dir = PathBuf::from(req.out_dir.context("fetch needs `outDir`")?);
            tokio::fs::create_dir_all(&out_dir).await?;

            // Three addressing modes:
            //  - ticket: full EndpointAddr — zero prior knowledge needed.
            //  - hash + provider: single origin (the N1/N2 catalog flow).
            //  - hash + providers[]: the swarm flow — the downloader walks
            //    the provider list (shuffled) with failover, so a snapshot
            //    stays fetchable while ANY holder is online, not just its
            //    author. Address resolution per provider is the usual
            //    MemoryLookup/discovery chain.
            if let Some(list) = &req.providers {
                let hash = Hash::from_str(&req.hash.context("fetch needs `hash` with `providers`")?)
                    .map_err(|e| anyhow!("bad hash: {e}"))?;
                let mut ids: Vec<EndpointId> = Vec::new();
                for p in list {
                    ids.push(EndpointId::from_str(p).map_err(|e| anyhow!("bad provider id '{p}': {e}"))?);
                }
                if ids.is_empty() { bail!("providers list is empty"); }
                node.store.downloader(&node.endpoint)
                    .download(hash, iroh_blobs::api::downloader::Shuffled::new(ids))
                    .await
                    .map_err(|e| anyhow!("swarm transfer failed (no reachable provider): {e}"))?;
                let out_path = out_dir.join(format!("{hash}.db"));
                node.store.blobs().export(hash, out_path.clone()).await
                    .map_err(|e| anyhow!("export to file failed: {e}"))?;
                let size = tokio::fs::metadata(&out_path).await?.len();
                return Ok(json!({
                    "hash": hash.to_string(),
                    "size": size,
                    "path": out_path.to_string_lossy(),
                }));
            }

            let (hash, addr): (Hash, iroh::EndpointAddr) = if let Some(t) = &req.ticket {
                let ticket = BlobTicket::from_str(t).map_err(|e| anyhow!("bad ticket: {e}"))?;
                (ticket.hash(), ticket.addr().clone())
            } else {
                let hash = Hash::from_str(&req.hash.context("fetch needs `ticket` or `hash`+`provider`")?)
                    .map_err(|e| anyhow!("bad hash: {e}"))?;
                let provider = EndpointId::from_str(&req.provider.context("fetch by hash needs `provider`")?)
                    .map_err(|e| anyhow!("bad provider id: {e}"))?;
                (hash, provider.into())
            };

            let conn = node.endpoint.connect(addr, iroh_blobs::ALPN)
                .await
                .map_err(|e| anyhow!("cannot reach the blob's origin: {e}"))?;
            node.store.remote().fetch(conn, hash).await
                .map_err(|e| anyhow!("transfer failed: {e}"))?;

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

        "join" => {
            let entries = req.bootstrap.unwrap_or_default();
            let mut ids: Vec<EndpointId> = Vec::new();
            for entry in &entries {
                // Tickets seed the MemoryLookup so the peer is dialable with
                // no external discovery; bare ids lean on the N0 preset.
                if let Ok(ticket) = EndpointTicket::from_str(entry) {
                    let addr = ticket.endpoint_addr().clone();
                    let id = addr.id;
                    node.memory_lookup.add_endpoint_info(addr);
                    ids.push(id);
                } else if let Ok(id) = EndpointId::from_str(entry) {
                    ids.push(id);
                } else {
                    bail!("bootstrap entry is neither an endpoint ticket nor an endpoint id: {entry}");
                }
            }
            ids.retain(|id| *id != node.endpoint.id());

            let mut sender_slot = node.topic_sender.lock().await;
            if let Some(sender) = sender_slot.as_ref() {
                // Already subscribed: just feed the new peers into the mesh.
                sender.join_peers(ids.clone()).await
                    .map_err(|e| anyhow!("join_peers failed: {e}"))?;
            } else {
                let topic = TopicId::from_bytes(*Hash::new(CATALOG_TOPIC).as_bytes());
                // subscribe() (NOT subscribe_and_join): returns immediately even
                // with zero reachable peers — the first node in the network must
                // not hang its RPC waiting for a mesh that doesn't exist yet.
                let topic_handle = node.gossip.subscribe(topic, ids.clone()).await
                    .map_err(|e| anyhow!("gossip subscribe failed: {e}"))?;
                let (sender, receiver) = topic_handle.split();
                *sender_slot = Some(sender.clone());
                tokio::spawn(receive_loop(node.clone(), receiver));
                tokio::spawn(announce_loop(node.clone(), sender.clone()));
                tokio::spawn(holds_loop(node.clone(), sender));
            }
            Ok(json!({ "joined": true, "bootstrapPeers": ids.len() }))
        }

        "announce" => {
            let payload = req.payload.context("announce needs `payload`")?;
            let payload = validate_payload(payload)?;
            let canonical = canonical_bytes(&node.endpoint.id().to_string(), &payload);
            let sig = node.secret_key.sign(&canonical);
            let ann = Announcement {
                v: 1,
                from: node.endpoint.id().to_string(),
                payload,
                sig: hex_encode(&sig.to_bytes()),
                n: 0,
            };
            let wire = announcement_wire(&node, &ann)?;
            *node.current_announcement.lock().await = Some(ann);
            // Broadcast immediately if we're on the topic; the announce loop
            // handles the periodic re-sends either way.
            let broadcast_now = node.topic_sender.lock().await.clone();
            if let Some(sender) = broadcast_now {
                sender.broadcast(wire.into()).await
                    .map_err(|e| anyhow!("broadcast failed: {e}"))?;
                Ok(json!({ "announced": true, "broadcast": true }))
            } else {
                Ok(json!({ "announced": true, "broadcast": false, "note": "not joined yet — will broadcast after join" }))
            }
        }

        // Update the set of snapshot hashes this node holds (own snapshot +
        // fetched shelf). Beaconed immediately when joined, then re-beaconed
        // by the holds loop. Node calls this after every shelf change.
        "setHolds" => {
            let mut hashes = req.hashes.context("setHolds needs `hashes`")?;
            if hashes.len() > MAX_HOLDS { bail!("too many holds ({} > {MAX_HOLDS})", hashes.len()); }
            for h in &hashes {
                if h.len() != 64 || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
                    bail!("holds entries must be 64-hex hashes");
                }
            }
            hashes.sort();
            hashes.dedup();
            *node.current_holds.lock().await = hashes;
            let sender = node.topic_sender.lock().await.clone();
            if let Some(sender) = sender {
                if let Ok(wire) = holds_wire(&node).await {
                    sender.broadcast(wire.into()).await
                        .map_err(|e| anyhow!("holds broadcast failed: {e}"))?;
                    return Ok(json!({ "set": true, "broadcast": true }));
                }
            }
            Ok(json!({ "set": true, "broadcast": false }))
        }

        // Unpin a blob so the store's GC reclaims it — called when a peer's
        // snapshot is replaced/removed, or when our own re-publish supersedes
        // the previous export. Deleting the TAGS is the whole job; the
        // collector (enabled at store load) sweeps untagged bytes.
        "forget" => {
            let hash = Hash::from_str(&req.hash.context("forget needs `hash`")?)
                .map_err(|e| anyhow!("bad hash: {e}"))?;
            use tokio_stream::StreamExt as _;
            let mut tags = node.store.tags().list().await
                .map_err(|e| anyhow!("tag list failed: {e}"))?;
            let mut removed = 0u32;
            while let Some(tag) = tags.next().await {
                let tag = tag.map_err(|e| anyhow!("tag stream error: {e}"))?;
                if tag.hash == hash {
                    node.store.tags().delete(tag.name.0.as_ref() as &[u8]).await
                        .map_err(|e| anyhow!("tag delete failed: {e}"))?;
                    removed += 1;
                }
            }
            Ok(json!({ "forgotten": removed > 0, "tagsRemoved": removed }))
        }

        "shutdown" => Ok(json!({})),

        other => Err(anyhow!("unknown command: {other}")),
    }
}

// Serialize the current holds beacon with a fresh anti-dedup counter.
// Signing string: context|from|hash1,hash2,... (hashes sorted; hex only, so
// the comma/pipe separators are unambiguous).
async fn holds_wire(node: &Node) -> Result<Vec<u8>> {
    let holds = node.current_holds.lock().await.clone();
    let from = node.endpoint.id().to_string();
    let sig = node.secret_key.sign(&holds_canonical(&from, &holds));
    let wire = serde_json::to_vec(&HoldsBeacon {
        v: 1,
        kind: "holds".into(),
        from,
        holds,
        sig: hex_encode(&sig.to_bytes()),
        n: node.heartbeat.fetch_add(1, Ordering::Relaxed),
    })?;
    if wire.len() > MAX_HOLDS_BYTES { bail!("holds beacon too large ({} bytes)", wire.len()); }
    Ok(wire)
}

fn holds_canonical(from: &str, holds: &[String]) -> Vec<u8> {
    format!("{HOLDS_SIGNING_CONTEXT}|{from}|{}", holds.join(",")).into_bytes()
}

// Re-beacon the current holds periodically (same no-history rationale as
// announcements). Skips empty holds — a node with nothing offers nothing.
async fn holds_loop(node: Arc<Node>, sender: GossipSender) {
    loop {
        tokio::time::sleep(HOLDS_INTERVAL).await;
        if node.current_holds.lock().await.is_empty() { continue; }
        match holds_wire(&node).await {
            Ok(wire) => {
                if let Err(e) = sender.broadcast(wire.into()).await {
                    eprintln!("[p2p-sidecar] periodic holds beacon failed: {e}");
                }
            }
            Err(e) => eprintln!("[p2p-sidecar] holds serialization failed: {e}"),
        }
    }
}

// Serialize an announcement with a fresh heartbeat counter so every send is
// unique bytes (gossip dedups identical content — see Announcement::n).
fn announcement_wire(node: &Node, ann: &Announcement) -> Result<Vec<u8>> {
    let mut out = ann.clone();
    out.n = node.heartbeat.fetch_add(1, Ordering::Relaxed);
    let wire = serde_json::to_vec(&out)?;
    if wire.len() > MAX_ANNOUNCEMENT_BYTES {
        bail!("announcement too large ({} bytes)", wire.len());
    }
    Ok(wire)
}

// Periodically re-broadcast the current announcement. Errors are logged, not
// fatal — a transient mesh hiccup shouldn't kill the announcer.
async fn announce_loop(node: Arc<Node>, sender: GossipSender) {
    loop {
        tokio::time::sleep(ANNOUNCE_INTERVAL).await;
        let ann = node.current_announcement.lock().await.clone();
        if let Some(ann) = ann {
            match announcement_wire(&node, &ann) {
                Ok(wire) => {
                    if let Err(e) = sender.broadcast(wire.into()).await {
                        eprintln!("[p2p-sidecar] periodic announce failed: {e}");
                    }
                }
                Err(e) => eprintln!("[p2p-sidecar] periodic announce serialization failed: {e}"),
            }
        }
    }
}

// Verify + rate-limit incoming gossip, forward good announcements to Node.
async fn receive_loop(node: Arc<Node>, mut receiver: GossipReceiver) {
    use tokio_stream::StreamExt;
    while let Some(event) = receiver.next().await {
        match event {
            Ok(Event::Received(msg)) => {
                if let Err(reason) = process_announcement(&node, &msg.content).await {
                    eprintln!("[p2p-sidecar] dropped announcement from {}: {reason}", msg.delivered_from);
                }
            }
            Ok(Event::NeighborUp(id)) => {
                node.neighbor_count.fetch_add(1, Ordering::Relaxed);
                let _ = node.out_tx.send(json!({"event":"neighbor","up":true,"id":id.to_string()}));
            }
            Ok(Event::NeighborDown(id)) => {
                node.neighbor_count.fetch_sub(1, Ordering::Relaxed);
                let _ = node.out_tx.send(json!({"event":"neighbor","up":false,"id":id.to_string()}));
            }
            Ok(Event::Lagged) => eprintln!("[p2p-sidecar] gossip receiver lagged — some announcements were missed"),
            Err(e) => {
                eprintln!("[p2p-sidecar] gossip stream error: {e}");
                break;
            }
        }
    }
}

// What a wire message proved itself to be. verify_wire() is PURE (no Node,
// no clocks) — it is the security boundary, so it gets direct unit tests
// (forged signatures, tampered fields, oversize, wrong kinds — see the
// tests module at the bottom of this file).
#[derive(Debug)]
enum Verified {
    Announce { from: String, payload: AnnouncePayload },
    Holds { from: String, holds: Vec<String> },
}

fn verify_wire(content: &[u8]) -> Result<Verified> {
    // Peek the kind before committing to a shape; absent kind = a v1
    // announcement (the original wire format predates the field).
    let peek: serde_json::Value = serde_json::from_slice(content).map_err(|e| anyhow!("unparseable: {e}"))?;
    let kind = peek.get("kind").and_then(|k| k.as_str()).unwrap_or("announce");

    let check_sig = |from: &str, canonical: &[u8], sig_hex: &str| -> Result<()> {
        // The signature is the ONLY thing tying a message to `from` —
        // gossip's delivered_from is just the last hop.
        let author = PublicKey::from_str(from).map_err(|e| anyhow!("bad author id: {e}"))?;
        let sig_bytes: [u8; 64] = hex_decode(sig_hex)?
            .try_into()
            .map_err(|_| anyhow!("bad signature length"))?;
        author.verify(canonical, &Signature::from_bytes(&sig_bytes))
            .map_err(|_| anyhow!("signature verification failed"))
    };

    match kind {
        "announce" => {
            if content.len() > MAX_ANNOUNCEMENT_BYTES { bail!("oversized ({} bytes)", content.len()); }
            let ann: Announcement = serde_json::from_slice(content).map_err(|e| anyhow!("unparseable: {e}"))?;
            if ann.v != 1 { bail!("unknown version {}", ann.v); }
            let payload = validate_payload(ann.payload)?;
            check_sig(&ann.from, &canonical_bytes(&ann.from, &payload), &ann.sig)?;
            Ok(Verified::Announce { from: ann.from, payload })
        }
        "holds" => {
            if content.len() > MAX_HOLDS_BYTES { bail!("oversized holds ({} bytes)", content.len()); }
            let b: HoldsBeacon = serde_json::from_slice(content).map_err(|e| anyhow!("unparseable: {e}"))?;
            if b.v != 1 { bail!("unknown version {}", b.v); }
            if b.holds.len() > MAX_HOLDS { bail!("too many holds ({})", b.holds.len()); }
            for h in &b.holds {
                if h.len() != 64 || !h.bytes().all(|c| c.is_ascii_hexdigit()) {
                    bail!("holds entries must be 64-hex hashes");
                }
            }
            check_sig(&b.from, &holds_canonical(&b.from, &b.holds), &b.sig)?;
            Ok(Verified::Holds { from: b.from, holds: b.holds })
        }
        other => bail!("unknown kind '{other}'"),
    }
}

async fn process_announcement(node: &Node, content: &[u8]) -> Result<()> {
    let verified = verify_wire(content)?;
    let (kind, from, marker) = match &verified {
        // For announcements, "news" = a higher snapshotSeq.
        Verified::Announce { from, payload } => ("announce", from.clone(), payload.snapshot_seq),
        // For holds, "news" = a changed hold set (order-insensitive marker).
        Verified::Holds { from, holds } => {
            use std::collections::hash_map::DefaultHasher;
            use std::hash::{Hash as _, Hasher};
            let mut sorted = holds.clone();
            sorted.sort();
            let mut h = DefaultHasher::new();
            sorted.hash(&mut h);
            ("holds", from.clone(), h.finish())
        }
    };
    if from == node.endpoint.id().to_string() { return Ok(()); } // our own echo

    // Flood guard, per (kind, origin): unchanged content coalesces to one
    // accept per gap (heartbeats), changed content passes immediately —
    // only the key holder can sign changed content, so third parties can't
    // exploit the fast path.
    {
        let mut last = node.last_accepted.lock().await;
        let now = Instant::now();
        let key = format!("{kind}:{from}");
        if let Some((prev, prev_marker)) = last.get(&key) {
            let is_news = marker != *prev_marker
                && !(kind == "announce" && marker < *prev_marker); // old seqs are never news
            if !is_news && now.duration_since(*prev) < MIN_ANNOUNCE_GAP { return Ok(()); } // coalesce
        }
        last.insert(key, (now, marker));
    }

    match verified {
        Verified::Announce { from, payload } => {
            let _ = node.out_tx.send(json!({ "event": "announcement", "from": from, "payload": payload }));
        }
        Verified::Holds { from, holds } => {
            let _ = node.out_tx.send(json!({ "event": "holds", "from": from, "holds": holds }));
        }
    }
    Ok(())
}

// Field sanity: hashes are 64 hex chars; strings are capped and must not
// contain the signing-string separator.
fn validate_payload(mut p: AnnouncePayload) -> Result<AnnouncePayload> {
    if p.hash.len() != 64 || !p.hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!("payload.hash must be 64 hex chars");
    }
    for (field, value, cap) in [
        ("modelId", &mut p.model_id, 128),
        ("modelVersion", &mut p.model_version, 128),
        ("name", &mut p.name, 64),
    ] {
        if value.len() > cap { bail!("payload.{field} too long"); }
        if value.contains('|') { bail!("payload.{field} must not contain '|'"); }
    }
    Ok(p)
}

// Deterministic signing input. Pipe-separated is safe because '|' is
// rejected in every free-text field above and the rest are hex/integers.
fn canonical_bytes(from: &str, p: &AnnouncePayload) -> Vec<u8> {
    format!(
        "{SIGNING_CONTEXT}|{from}|{}|{}|{}|{}|{}|{}|{}",
        p.hash, p.size, p.row_count, p.model_id, p.model_version, p.snapshot_seq, p.name
    )
    .into_bytes()
}

fn endpoint_ticket(node: &Node) -> String {
    EndpointTicket::new(node.endpoint.addr()).to_string()
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hex_decode(s: &str) -> Result<Vec<u8>> {
    if s.len() % 2 != 0 { bail!("odd-length hex"); }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| anyhow!("bad hex: {e}")))
        .collect()
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

#[cfg(test)]
mod tests {
    use super::*;

    fn signed_announcement(sk: &SecretKey, from_override: Option<String>, mutate: impl FnOnce(&mut AnnouncePayload)) -> Vec<u8> {
        let mut payload = AnnouncePayload {
            hash: "ab".repeat(32),
            size: 1024,
            row_count: 10,
            model_id: "test-model".into(),
            model_version: "1".into(),
            snapshot_seq: 7,
            name: "Unit Test".into(),
        };
        let from = from_override.unwrap_or_else(|| sk.public().to_string());
        let sig = sk.sign(&canonical_bytes(&from, &payload));
        mutate(&mut payload); // tampering happens AFTER signing
        serde_json::to_vec(&Announcement {
            v: 1, from, payload, sig: hex_encode(&sig.to_bytes()), n: 0,
        }).unwrap()
    }

    fn signed_holds(sk: &SecretKey, holds: Vec<String>, tamper: bool) -> Vec<u8> {
        let from = sk.public().to_string();
        let sig = sk.sign(&holds_canonical(&from, &holds));
        let holds = if tamper {
            let mut t = holds.clone();
            t.push("cd".repeat(32)); // claim one more snapshot than was signed
            t
        } else { holds };
        serde_json::to_vec(&HoldsBeacon {
            v: 1, kind: "holds".into(), from, holds, sig: hex_encode(&sig.to_bytes()), n: 0,
        }).unwrap()
    }

    #[test]
    fn valid_announcement_verifies() {
        let sk = SecretKey::generate();
        let wire = signed_announcement(&sk, None, |_| {});
        match verify_wire(&wire).expect("must verify") {
            Verified::Announce { from, payload } => {
                assert_eq!(from, sk.public().to_string());
                assert_eq!(payload.snapshot_seq, 7);
            }
            other => panic!("wrong kind: {other:?}"),
        }
    }

    #[test]
    fn tampered_payload_is_rejected() {
        let sk = SecretKey::generate();
        // Inflate the advertised library size after signing — the classic
        // "make my snapshot look popular/bigger" forgery.
        let wire = signed_announcement(&sk, None, |p| { p.row_count = 999_999; });
        assert!(verify_wire(&wire).is_err(), "tampered rowCount must not verify");
    }

    #[test]
    fn impersonation_is_rejected() {
        // Signed with attacker's key but claiming victim's identity.
        let attacker = SecretKey::generate();
        let victim = SecretKey::generate();
        let wire = signed_announcement(&attacker, Some(victim.public().to_string()), |_| {});
        assert!(verify_wire(&wire).is_err(), "cross-identity signature must not verify");
    }

    #[test]
    fn oversized_and_malformed_are_rejected() {
        let sk = SecretKey::generate();
        let mut wire = signed_announcement(&sk, None, |_| {});
        wire.extend(std::iter::repeat(b' ').take(MAX_ANNOUNCEMENT_BYTES));
        assert!(verify_wire(&wire).is_err(), "oversized must be rejected");
        assert!(verify_wire(b"not json at all").is_err());
        assert!(verify_wire(br#"{"kind":"mystery","v":1}"#).is_err(), "unknown kind must be rejected");
    }

    #[test]
    fn pipe_in_name_is_rejected() {
        // '|' is the signing-string separator; a name containing it could
        // shift field boundaries. validate_payload must refuse it outright.
        let sk = SecretKey::generate();
        let mut payload = AnnouncePayload {
            hash: "ab".repeat(32), size: 1, row_count: 1,
            model_id: "m".into(), model_version: "1".into(), snapshot_seq: 1,
            name: "evil|1000000".into(),
        };
        let from = sk.public().to_string();
        let sig = sk.sign(&canonical_bytes(&from, &payload));
        payload.name = "evil|1000000".into();
        let wire = serde_json::to_vec(&Announcement { v: 1, from, payload, sig: hex_encode(&sig.to_bytes()), n: 0 }).unwrap();
        assert!(verify_wire(&wire).is_err());
    }

    #[test]
    fn valid_holds_beacon_verifies() {
        let sk = SecretKey::generate();
        let holds = vec!["ef".repeat(32), "01".repeat(32)];
        let wire = signed_holds(&sk, holds.clone(), false);
        match verify_wire(&wire).expect("must verify") {
            Verified::Holds { from, holds: got } => {
                assert_eq!(from, sk.public().to_string());
                assert_eq!(got, holds);
            }
            other => panic!("wrong kind: {other:?}"),
        }
    }

    #[test]
    fn tampered_holds_are_rejected() {
        // Adding an unsigned hash = claiming to seed something you don't —
        // the exact forgery that would corrupt seeder counts.
        let sk = SecretKey::generate();
        let wire = signed_holds(&sk, vec!["ef".repeat(32)], true);
        assert!(verify_wire(&wire).is_err(), "padded hold set must not verify");
    }
}
