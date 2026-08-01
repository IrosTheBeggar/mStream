use std::env;
use std::fs::File;
use std::io::BufReader;
use std::sync::{Arc, Mutex};
use std::time::Duration;

// rodio 0.22 renamed Sink to Player; aliased back so the rest of this file
// reads the same, and so it doesn't collide with the local Player struct.
use rodio::mixer::Mixer;
use rodio::{Decoder, DeviceSinkBuilder, MixerDeviceSink, Player as Sink};
use serde::{Deserialize, Serialize};
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tiny_http::{Header, Method, Response, Server};

// ── Request / Response types ────────────────────────────────────────────────

#[derive(Deserialize)]
struct PlayRequest {
    file: String,
}

#[derive(Deserialize)]
struct AddManyRequest {
    files: Vec<String>,
}

#[derive(Deserialize)]
struct IndexRequest {
    index: usize,
}

#[derive(Deserialize)]
struct SeekRequest {
    position: f64,
}

#[derive(Deserialize)]
struct VolumeRequest {
    volume: f32,
}

#[derive(Deserialize)]
struct BoolRequest {
    value: bool,
}

#[derive(Serialize)]
struct StatusResponse {
    playing: bool,
    paused: bool,
    position: f64,
    duration: f64,
    volume: f32,
    file: String,
    queue_index: usize,
    queue_length: usize,
    shuffle: bool,
    loop_mode: String, // "none", "one", "all"
}

#[derive(Serialize)]
struct QueueResponse {
    queue: Vec<String>,
    current_index: usize,
}

#[derive(Serialize)]
struct OkResponse {
    ok: bool,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
}

// ── Loop mode ───────────────────────────────────────────────────────────────

#[derive(Clone, PartialEq)]
enum LoopMode {
    None,
    One,
    All,
}

impl LoopMode {
    fn as_str(&self) -> &str {
        match self {
            LoopMode::None => "none",
            LoopMode::One => "one",
            LoopMode::All => "all",
        }
    }
    fn next(&self) -> LoopMode {
        match self {
            LoopMode::None => LoopMode::One,
            LoopMode::One => LoopMode::All,
            LoopMode::All => LoopMode::None,
        }
    }
}

// ── Player state ────────────────────────────────────────────────────────────

struct SharedState {
    sink: Sink,
    current_file: String,
    duration: f64,
    queue: Vec<String>,
    queue_index: usize,
    stopped: bool,
    shuffle: bool,
    loop_mode: LoopMode,
    /// Desired volume, kept here because a new sink is built for every track
    /// and starts at full volume otherwise.
    volume: f32,
}

struct Player {
    // Field order matters for drop: the sinks inside `shared` must go before
    // the device that owns the output stream.
    shared: Arc<Mutex<SharedState>>,
    device: MixerDeviceSink,
}

impl Player {
    fn new() -> Result<Self, String> {
        let mut device = DeviceSinkBuilder::open_default_sink()
            .map_err(|e| format!("Failed to open audio output device: {}", e))?;
        // We manage the lifetime; the default drop warning is just noise.
        device.log_on_drop(false);
        let sink = Sink::connect_new(device.mixer());

        let shared = Arc::new(Mutex::new(SharedState {
            sink,
            current_file: String::new(),
            duration: 0.0,
            queue: Vec::new(),
            queue_index: 0,
            stopped: true,
            shuffle: false,
            loop_mode: LoopMode::None,
            volume: 1.0,
        }));

        Ok(Player { shared, device })
    }
}

fn play_current(state: &mut SharedState, mixer: &Mixer) -> bool {
    if state.queue_index >= state.queue.len() {
        return false;
    }

    let path = state.queue[state.queue_index].clone();
    let file = match File::open(&path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    // Hand the decoder the file length. Symphonia needs it to binary-search
    // for a seek point in files without a seek table — notably FLACs written
    // without a SEEKTABLE block, which were previously unseekable because
    // rodio's decoder reported byte_len as None.
    let byte_len = file.metadata().ok().map(|m| m.len());
    let mut builder = Decoder::builder().with_data(BufReader::new(file)).with_seekable(true);
    if let Some(len) = byte_len {
        builder = builder.with_byte_len(len);
    }
    let source = match builder.build() {
        Ok(s) => s,
        Err(_) => return false,
    };

    let duration = get_file_duration(&path);

    state.sink.stop();
    state.sink = Sink::connect_new(mixer);
    state.sink.set_volume(state.volume);
    state.sink.append(source);
    state.current_file = path;
    state.duration = duration;
    state.stopped = false;
    true
}

/// Pick the next index based on shuffle/loop settings.
///
/// `manual` marks a user-pressed skip. Those honour shuffle and loop-all, but
/// are never held on the same track by loop-one — otherwise pressing next
/// during loop-one replays the current track forever with no way out.
fn pick_next_index(state: &SharedState, manual: bool) -> Option<usize> {
    if state.queue.is_empty() {
        return None;
    }

    if !manual && state.loop_mode == LoopMode::One {
        return Some(state.queue_index);
    }

    if state.shuffle {
        if state.queue.len() <= 1 {
            return Some(0);
        }
        // Pick a different index than current
        let offset = fastrand::usize(1..state.queue.len());
        return Some((state.queue_index + offset) % state.queue.len());
    }

    let next = state.queue_index + 1;
    if next < state.queue.len() {
        Some(next)
    } else if state.loop_mode == LoopMode::All {
        Some(0) // wrap around
    } else {
        None // end of queue
    }
}

// ── Duration detection via symphonia ────────────────────────────────────────

fn get_file_duration(path: &str) -> f64 {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return 0.0,
    };

    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = std::path::Path::new(path).extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = match symphonia::default::get_probe().format(
        &hint, mss, &FormatOptions::default(), &MetadataOptions::default()
    ) {
        Ok(p) => p,
        Err(_) => return 0.0,
    };

    if let Some(track) = probed.format.default_track() {
        if let Some(n_frames) = track.codec_params.n_frames {
            if let Some(sr) = track.codec_params.sample_rate {
                if sr > 0 { return n_frames as f64 / sr as f64; }
            }
        }
        if let Some(tb) = track.codec_params.time_base {
            if let Some(n_frames) = track.codec_params.n_frames {
                let d = tb.calc_time(n_frames);
                return d.seconds as f64 + d.frac;
            }
        }
    }
    0.0
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

fn json_response<T: Serialize>(data: &T) -> Response<std::io::Cursor<Vec<u8>>> {
    let body = serde_json::to_vec(data).unwrap_or_default();
    let header = Header::from_bytes("Content-Type", "application/json").unwrap();
    Response::from_data(body).with_header(header)
}

fn error_response(msg: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    let resp = ErrorResponse { error: msg.to_string() };
    let body = serde_json::to_vec(&resp).unwrap_or_default();
    let header = Header::from_bytes("Content-Type", "application/json").unwrap();
    Response::from_data(body).with_header(header).with_status_code(400)
}

fn read_body(request: &mut tiny_http::Request) -> Option<String> {
    let mut body = String::new();
    request.as_reader().read_to_string(&mut body).ok()?;
    if body.is_empty() { None } else { Some(body) }
}

fn ok_resp() -> Response<std::io::Cursor<Vec<u8>>> {
    json_response(&OkResponse { ok: true })
}

// ── Request handlers ────────────────────────────────────────────────────────

type State = Arc<Mutex<SharedState>>;
type Resp = Response<std::io::Cursor<Vec<u8>>>;

fn handle_play(state: &State, sh: &Mixer, body: &str) -> Resp {
    let req: PlayRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(e) => return error_response(&format!("Invalid JSON: {}", e)),
    };
    let mut s = state.lock().unwrap();
    s.queue.clear();
    s.queue.push(req.file);
    s.queue_index = 0;
    if play_current(&mut s, sh) { ok_resp() } else { error_response("Failed to play file") }
}

fn handle_pause(state: &State) -> Resp {
    state.lock().unwrap().sink.pause();
    ok_resp()
}

fn handle_resume(state: &State) -> Resp {
    state.lock().unwrap().sink.play();
    ok_resp()
}

fn handle_stop(state: &State) -> Resp {
    let mut s = state.lock().unwrap();
    s.sink.stop();
    s.current_file.clear();
    s.duration = 0.0;
    s.stopped = true;
    ok_resp()
}

fn handle_seek(state: &State, body: &str) -> Resp {
    let req: SeekRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(e) => return error_response(&format!("Invalid JSON: {}", e)),
    };
    // Duration::from_secs_f64 panics on negative or non-finite input, and a
    // panic while holding this mutex poisons it — every later request would
    // then fail. Validate before converting.
    if !req.position.is_finite() || req.position < 0.0 {
        return error_response("Seek failed: position must be a non-negative number");
    }
    let s = state.lock().unwrap();
    match s.sink.try_seek(Duration::from_secs_f64(req.position)) {
        Ok(_) => ok_resp(),
        Err(e) => error_response(&format!("Seek failed: {}", e)),
    }
}

fn handle_volume(state: &State, body: &str) -> Resp {
    let req: VolumeRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(e) => return error_response(&format!("Invalid JSON: {}", e)),
    };
    let mut s = state.lock().unwrap();
    let volume = req.volume.clamp(0.0, 1.0);
    s.volume = volume;
    s.sink.set_volume(volume);
    ok_resp()
}

fn handle_status(state: &State) -> Resp {
    let s = state.lock().unwrap();
    let is_empty = s.sink.empty();
    let is_paused = s.sink.is_paused();

    json_response(&StatusResponse {
        // `stopped` is set synchronously by /stop, while sink.empty() only
        // flips on the next audio callback — without it, /status reports
        // playing:true for a few ms after a stop.
        playing: !is_empty && !is_paused && !s.stopped,
        paused: is_paused,
        position: s.sink.get_pos().as_secs_f64(),
        duration: s.duration,
        volume: s.sink.volume(),
        file: s.current_file.clone(),
        queue_index: s.queue_index,
        queue_length: s.queue.len(),
        shuffle: s.shuffle,
        loop_mode: s.loop_mode.as_str().to_string(),
    })
}

fn handle_next(state: &State, sh: &Mixer) -> Resp {
    let mut s = state.lock().unwrap();
    match pick_next_index(&s, true) {
        Some(idx) => {
            s.queue_index = idx;
            if play_current(&mut s, sh) { ok_resp() } else { error_response("Failed to play next track") }
        }
        None => error_response("Already at end of queue"),
    }
}

fn handle_previous(state: &State, sh: &Mixer) -> Resp {
    let mut s = state.lock().unwrap();
    if s.queue_index == 0 {
        if s.loop_mode == LoopMode::All && !s.queue.is_empty() {
            s.queue_index = s.queue.len() - 1;
            if play_current(&mut s, sh) { ok_resp() } else { error_response("Failed to play") }
        } else {
            let _ = s.sink.try_seek(Duration::ZERO);
            ok_resp()
        }
    } else {
        s.queue_index -= 1;
        if play_current(&mut s, sh) { ok_resp() } else { error_response("Failed to play previous track") }
    }
}

fn handle_shuffle(state: &State, body: &str) -> Resp {
    let req: BoolRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(e) => return error_response(&format!("Invalid JSON: {}", e)),
    };
    state.lock().unwrap().shuffle = req.value;
    ok_resp()
}

fn handle_loop(state: &State) -> Resp {
    let mut s = state.lock().unwrap();
    s.loop_mode = s.loop_mode.next();
    json_response(&serde_json::json!({ "ok": true, "loop_mode": s.loop_mode.as_str() }))
}

// ── Queue handlers ──────────────────────────────────────────────────────────

fn handle_queue_add(state: &State, sh: &Mixer, body: &str) -> Resp {
    let req: PlayRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(e) => return error_response(&format!("Invalid JSON: {}", e)),
    };
    let mut s = state.lock().unwrap();
    let was_empty = s.queue.is_empty();
    s.queue.push(req.file);
    if was_empty && s.sink.empty() {
        s.queue_index = 0;
        play_current(&mut s, sh);
    }
    ok_resp()
}

fn handle_queue_add_many(state: &State, sh: &Mixer, body: &str) -> Resp {
    let req: AddManyRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(e) => return error_response(&format!("Invalid JSON: {}", e)),
    };
    let mut s = state.lock().unwrap();
    let was_empty = s.queue.is_empty();
    s.queue.extend(req.files);
    if was_empty && s.sink.empty() {
        s.queue_index = 0;
        play_current(&mut s, sh);
    }
    ok_resp()
}

fn handle_queue_play_index(state: &State, sh: &Mixer, body: &str) -> Resp {
    let req: IndexRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(e) => return error_response(&format!("Invalid JSON: {}", e)),
    };
    let mut s = state.lock().unwrap();
    if req.index >= s.queue.len() { return error_response("Index out of bounds"); }
    s.queue_index = req.index;
    if play_current(&mut s, sh) { ok_resp() } else { error_response("Failed to play track at index") }
}

fn handle_queue_remove(state: &State, sh: &Mixer, body: &str) -> Resp {
    let req: IndexRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(e) => return error_response(&format!("Invalid JSON: {}", e)),
    };
    let mut s = state.lock().unwrap();
    if req.index >= s.queue.len() { return error_response("Index out of bounds"); }
    s.queue.remove(req.index);

    if s.queue.is_empty() {
        s.queue_index = 0;
        s.sink.stop();
        s.current_file.clear();
        s.duration = 0.0;
        s.stopped = true;
    } else if req.index < s.queue_index {
        s.queue_index -= 1;
    } else if req.index == s.queue_index {
        if s.queue_index >= s.queue.len() { s.queue_index = s.queue.len() - 1; }
        // Only resume if something was actually playing; removing a queue
        // entry while stopped shouldn't start audio as a side effect.
        if !s.stopped {
            play_current(&mut s, sh);
        }
    }
    ok_resp()
}

fn handle_queue_clear(state: &State) -> Resp {
    let mut s = state.lock().unwrap();
    s.sink.stop();
    s.queue.clear();
    s.queue_index = 0;
    s.current_file.clear();
    s.duration = 0.0;
    s.stopped = true;
    ok_resp()
}

fn handle_queue_get(state: &State) -> Resp {
    let s = state.lock().unwrap();
    json_response(&QueueResponse { queue: s.queue.clone(), current_index: s.queue_index })
}

// ── Main ────────────────────────────────────────────────────────────────────

fn main() {
    let args: Vec<String> = env::args().collect();
    let mut port: u16 = 3333;
    // Loopback by default: this API has no authentication, and it can play
    // any local file path and report whether it exists. mStream only ever
    // connects over 127.0.0.1. Pass --host 0.0.0.0 to restore the old
    // listen-on-everything behaviour.
    let mut host = String::from("127.0.0.1");

    let mut i = 1;
    while i < args.len() {
        if args[i] == "--port" && i + 1 < args.len() {
            port = args[i + 1].parse().unwrap_or(3333);
            i += 2;
        } else if args[i] == "--host" && i + 1 < args.len() {
            host = args[i + 1].clone();
            i += 2;
        } else {
            i += 1;
        }
    }

    // A missing or busy audio device is a normal condition on a headless box;
    // report it and exit instead of panicking with a backtrace.
    let player = match Player::new() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("{}", e);
            std::process::exit(1);
        }
    };
    let state = Arc::clone(&player.shared);
    let mixer = player.device.mixer();

    let addr = format!("{}:{}", host, port);
    let server = Server::http(&addr).unwrap_or_else(|e| {
        eprintln!("Failed to start server on {}: {}", addr, e);
        std::process::exit(1);
    });

    println!("rust-server-audio listening on http://{}", addr);

    loop {
        // Auto-advance: check if sink emptied and advance to next track
        {
            let mut s = state.lock().unwrap();
            if s.sink.empty() && !s.stopped && !s.queue.is_empty() {
                let mut attempts = 0;
                loop {
                    match pick_next_index(&s, false) {
                        Some(idx) => {
                            s.queue_index = idx;
                            if play_current(&mut s, mixer) {
                                break; // successfully started playing
                            }
                            // Failed to decode — try next track
                            attempts += 1;
                            if attempts >= s.queue.len() {
                                // Tried all tracks, none playable
                                s.stopped = true;
                                s.current_file.clear();
                                s.duration = 0.0;
                                break;
                            }
                        }
                        None => {
                            s.stopped = true;
                            s.current_file.clear();
                            s.duration = 0.0;
                            break;
                        }
                    }
                }
            }
        }

        let request = server.recv_timeout(Duration::from_millis(250));
        let mut request = match request {
            Ok(Some(r)) => r,
            Ok(None) => continue,
            Err(_) => continue,
        };

        let method = request.method().clone();
        let path = request.url().to_string();
        let body = read_body(&mut request);

        let response = match (method, path.as_str()) {
            (Method::Post, "/play") => match body { Some(b) => handle_play(&state, mixer, &b), None => error_response("Missing request body") },
            (Method::Post, "/pause")    => handle_pause(&state),
            (Method::Post, "/resume")   => handle_resume(&state),
            (Method::Post, "/stop")     => handle_stop(&state),
            (Method::Post, "/next")     => handle_next(&state, mixer),
            (Method::Post, "/previous") => handle_previous(&state, mixer),
            (Method::Post, "/seek")     => match body { Some(b) => handle_seek(&state, &b), None => error_response("Missing request body") },
            (Method::Post, "/volume")   => match body { Some(b) => handle_volume(&state, &b), None => error_response("Missing request body") },
            (Method::Post, "/shuffle")  => match body { Some(b) => handle_shuffle(&state, &b), None => error_response("Missing request body") },
            (Method::Post, "/loop")     => handle_loop(&state),
            (Method::Get, "/status")    => handle_status(&state),

            (Method::Post, "/queue/add")        => match body { Some(b) => handle_queue_add(&state, mixer, &b), None => error_response("Missing request body") },
            (Method::Post, "/queue/add-many")   => match body { Some(b) => handle_queue_add_many(&state, mixer, &b), None => error_response("Missing request body") },
            (Method::Post, "/queue/play-index") => match body { Some(b) => handle_queue_play_index(&state, mixer, &b), None => error_response("Missing request body") },
            (Method::Post, "/queue/remove")     => match body { Some(b) => handle_queue_remove(&state, mixer, &b), None => error_response("Missing request body") },
            (Method::Post, "/queue/clear")      => handle_queue_clear(&state),
            (Method::Get, "/queue")             => handle_queue_get(&state),

            _ => {
                let resp = ErrorResponse { error: "Not found".to_string() };
                let b = serde_json::to_vec(&resp).unwrap_or_default();
                let h = Header::from_bytes("Content-Type", "application/json").unwrap();
                Response::from_data(b).with_header(h).with_status_code(404)
            }
        };

        let _ = request.respond(response);
    }
}
