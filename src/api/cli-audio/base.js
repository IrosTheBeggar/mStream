/**
 * BaseCliAdapter — shared queue state + HTTP-style request dispatcher.
 *
 * Sub-classes provide concrete player control by overriding the `_*` hooks
 * (e.g. _loadFile, _pause, _getPosition). The base class manages queue,
 * shuffle, loop, and translates the REST-ish routes used by the Rust binary
 * into adapter method calls, so `proxyToCli()` can be a drop-in replacement
 * for `proxyToRust()` in server-playback.js.
 */

import WebError from '../../util/web-error.js';

const LOOP_MODES = ['none', 'one', 'all'];

export class BaseCliAdapter {
  constructor(playerName) {
    this.playerName = playerName;
    this.queue = [];
    this.queueIndex = 0;
    this.shuffle = false;
    this.loopMode = 'none';
    this.volume = 1.0;
    this.paused = false;
    this.stopped = true;
    this.currentFile = '';
    this.duration = 0;
  }

  // ── Subclass hooks (override these) ────────────────────────────────────

  async start() { /* spawn + connect */ }
  async stop() { /* kill */ }

  async _loadFile(_absPath) { throw new Error('not implemented'); }
  async _pause() { throw new Error('not implemented'); }
  async _resume() { throw new Error('not implemented'); }
  async _stop() { throw new Error('not implemented'); }
  async _seek(_seconds) { throw new Error('not implemented'); }
  async _setVolume(_vol01) { throw new Error('not implemented'); }
  async _getPosition() { return 0; }
  async _getDuration() { return this.duration; }

  // ── High-level actions ─────────────────────────────────────────────────

  async play(absPath) {
    this.queue = [absPath];
    this.queueIndex = 0;
    await this._loadFile(absPath);
    this.currentFile = absPath;
    this.paused = false;
    this.stopped = false;
  }

  async pause() {
    await this._pause();
    this.paused = true;
  }

  async resume() {
    await this._resume();
    this.paused = false;
  }

  async stopPlayback() {
    await this._stop();
    this.currentFile = '';
    this.paused = false;
    this.stopped = true;
  }

  async seek(seconds) {
    await this._seek(Number(seconds) || 0);
  }

  async setVolume(vol01) {
    const v = Math.max(0, Math.min(1, Number(vol01) || 0));
    await this._setVolume(v);
    this.volume = v;
  }

  async setShuffle(value) {
    this.shuffle = !!value;
  }

  async cycleLoop() {
    const idx = LOOP_MODES.indexOf(this.loopMode);
    this.loopMode = LOOP_MODES[(idx + 1) % LOOP_MODES.length];
  }

  async next() {
    const idx = this._pickNextIndex();
    if (idx === null) { throw new WebError('Already at end of queue', 409); }
    this.queueIndex = idx;
    await this._loadCurrent();
  }

  async previous() {
    if (this.queue.length === 0) { throw new WebError('Queue is empty', 409); }
    if (this.queueIndex === 0) {
      if (this.loopMode === 'all') {
        this.queueIndex = this.queue.length - 1;
        await this._loadCurrent();
      } else {
        await this._seek(0);
      }
    } else {
      this.queueIndex -= 1;
      await this._loadCurrent();
    }
  }

  async queueAdd(absPath) {
    const wasEmpty = this.queue.length === 0;
    this.queue.push(absPath);
    if (wasEmpty) {
      this.queueIndex = 0;
      await this._loadCurrent();
    }
  }

  async queueAddMany(absPaths) {
    const wasEmpty = this.queue.length === 0;
    for (const p of absPaths) { this.queue.push(p); }
    if (wasEmpty && this.queue.length > 0) {
      this.queueIndex = 0;
      await this._loadCurrent();
    }
  }

  async queuePlayIndex(index) {
    if (index < 0 || index >= this.queue.length) {
      throw new WebError('Index out of range', 400);
    }
    this.queueIndex = index;
    await this._loadCurrent();
  }

  async queueRemove(index) {
    if (index < 0 || index >= this.queue.length) {
      throw new WebError('Index out of range', 400);
    }
    this.queue.splice(index, 1);
    if (this.queue.length === 0) {
      this.queueIndex = 0;
      await this.stopPlayback();
    } else if (index < this.queueIndex) {
      this.queueIndex -= 1;
    } else if (index === this.queueIndex) {
      this.queueIndex = Math.min(index, this.queue.length - 1);
      await this._loadCurrent();
    }
  }

  async queueClear() {
    this.queue = [];
    this.queueIndex = 0;
    await this.stopPlayback();
  }

  async getStatus() {
    const position = await this._getPosition().catch(() => 0);
    const duration = await this._getDuration().catch(() => this.duration);
    return {
      playing: !this.paused && !this.stopped && this.currentFile !== '',
      paused: this.paused,
      position: Number(position) || 0,
      duration: Number(duration) || 0,
      volume: this.volume,
      file: this.currentFile,
      queue_index: this.queueIndex,
      queue_length: this.queue.length,
      shuffle: this.shuffle,
      loop_mode: this.loopMode,
    };
  }

  async getQueue() {
    return { queue: this.queue.slice() };
  }

  // ── Internal helpers ───────────────────────────────────────────────────

  _pickNextIndex() {
    if (this.queue.length === 0) { return null; }
    if (this.loopMode === 'one') { return this.queueIndex; }
    if (this.shuffle) {
      if (this.queue.length <= 1) { return 0; }
      const offset = Math.floor(Math.random() * (this.queue.length - 1)) + 1;
      return (this.queueIndex + offset) % this.queue.length;
    }
    const next = this.queueIndex + 1;
    if (next < this.queue.length) { return next; }
    if (this.loopMode === 'all') { return 0; }
    return null;
  }

  async _loadCurrent() {
    if (this.queueIndex < 0 || this.queueIndex >= this.queue.length) { return; }
    const path = this.queue[this.queueIndex];
    await this._loadFile(path);
    this.currentFile = path;
    this.paused = false;
    this.stopped = false;
  }

  // Called by the subclass when the current track finishes on its own.
  // Advances the queue respecting shuffle/loop, and loads the next track.
  async _onTrackEnded() {
    const idx = this._pickNextIndex();
    if (idx === null) {
      this.stopped = true;
      this.currentFile = '';
      return;
    }
    this.queueIndex = idx;
    try { await this._loadCurrent(); } catch (_e) { /* swallow */ }
  }

  // ── Route dispatcher (matches rust binary paths) ───────────────────────

  async handleRequest(method, rustPath, body = {}) {
    try {
      const data = await this._dispatch(method, rustPath, body || {});
      return { status: 200, data: data ?? { ok: true } };
    } catch (e) {
      // Known conditions carry their HTTP status via WebError (503 player
      // unavailable, 409 queue-state, 404 unknown route, 400 bad input).
      // Anything else is an unexpected internal failure → 500, not a blanket
      // 400 that hides real bugs as "client error".
      return { status: e instanceof WebError ? e.status : 500, data: { error: e.message } };
    }
  }

  async _dispatch(method, rustPath, body) {
    const key = `${method} ${rustPath}`;
    switch (key) {
      case 'POST /play':
        if (!body.file) { throw new WebError('Missing file', 400); }
        await this.play(body.file);
        return { ok: true };
      case 'POST /pause':
        await this.pause();
        return { ok: true };
      case 'POST /resume':
        await this.resume();
        return { ok: true };
      case 'POST /stop':
        await this.stopPlayback();
        return { ok: true };
      case 'POST /next':
        await this.next();
        return { ok: true };
      case 'POST /previous':
        await this.previous();
        return { ok: true };
      case 'POST /seek':
        await this.seek(body.position);
        return { ok: true };
      case 'POST /volume':
        await this.setVolume(body.volume);
        return { ok: true };
      case 'POST /shuffle':
        await this.setShuffle(body.value);
        return { ok: true };
      case 'POST /loop':
        await this.cycleLoop();
        return { ok: true };
      case 'POST /queue/add':
        if (!body.file) { throw new WebError('Missing file', 400); }
        await this.queueAdd(body.file);
        return { ok: true };
      case 'POST /queue/add-many':
        if (!Array.isArray(body.files)) { throw new WebError('Missing files', 400); }
        await this.queueAddMany(body.files);
        return { ok: true };
      case 'POST /queue/play-index':
        await this.queuePlayIndex(Number(body.index));
        return { ok: true };
      case 'POST /queue/remove':
        await this.queueRemove(Number(body.index));
        return { ok: true };
      case 'POST /queue/clear':
        await this.queueClear();
        return { ok: true };
      case 'GET /status':
        return this.getStatus();
      case 'GET /queue':
        return this.getQueue();
      default:
        throw new WebError(`Unsupported route: ${key}`, 404);
    }
  }
}
