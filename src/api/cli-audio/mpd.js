/**
 * MpdAdapter — controls an already-running MPD daemon over its text protocol.
 *
 * Unlike the other adapters we don't spawn a process: MPD is a long-running
 * daemon users configure themselves (music_directory, audio output, etc.).
 * We just connect to it, verify the welcome banner, and forward commands.
 *
 * Connection target is read from MSTREAM_MPD_HOST, with two supported forms:
 *   - "host:port"      — TCP (default: 127.0.0.1:6600)
 *   - "/path/to/sock"  — Unix socket (common on Debian/Ubuntu)
 *
 * MPD 0.22+ restricts `file://` URIs to local (Unix-socket) connections for
 * security, so the Unix socket path is strongly preferred when the server
 * runs on the same host as MPD.
 *
 * Wire format (text, line-based):
 *   Request:  "<command> [<args>]\n"
 *   Response: key/value lines terminated by "OK\n" (success) or
 *             "ACK [<err>@<line>] {<cmd>} <msg>\n" (failure).
 */

import net from 'net';
import winston from 'winston';
import { BaseCliAdapter } from './base.js';

export const MPD_DEFAULT_HOST = '127.0.0.1';
export const MPD_DEFAULT_PORT = 6600;

/**
 * Parse either "host:port" or "/absolute/socket/path". Absolute-path form
 * (starts with `/` on Unix) routes via a Unix socket; everything else is
 * treated as TCP.
 */
export function parseMpdHost(value) {
  const raw = (value || '').trim();
  if (!raw) { return { kind: 'tcp', host: MPD_DEFAULT_HOST, port: MPD_DEFAULT_PORT }; }
  if (raw.startsWith('/')) { return { kind: 'unix', path: raw }; }
  const m = raw.match(/^([^:]+)(?::(\d+))?$/);
  if (!m) { return { kind: 'tcp', host: MPD_DEFAULT_HOST, port: MPD_DEFAULT_PORT }; }
  return { kind: 'tcp', host: m[1], port: m[2] ? Number(m[2]) : MPD_DEFAULT_PORT };
}

function connectOpts(target) {
  return target.kind === 'unix' ? { path: target.path } : { host: target.host, port: target.port };
}

/**
 * Opens a short-lived connection and checks for MPD's "OK MPD <ver>" banner.
 * Used both by the registry's detection probe and by the adapter's own health
 * check. Resolves true/false, never rejects.
 */
export function probeMpd({ target, timeoutMs = 1000 } = {}) {
  const t = target || parseMpdHost(process.env.MSTREAM_MPD_HOST || '');
  return new Promise((resolve) => {
    let done = false;
    let sock;
    const finish = (ok) => {
      if (done) { return; }
      done = true;
      try { sock && sock.destroy(); } catch (_) { /* ignore */ }
      resolve(ok);
    };
    try { sock = net.connect(connectOpts(t)); }
    catch (_e) { return finish(false); }
    sock.setTimeout(timeoutMs);
    sock.once('data', (chunk) => finish(/^OK MPD /.test(chunk.toString())));
    sock.once('error', () => finish(false));
    sock.once('timeout', () => finish(false));
  });
}

export class MpdAdapter extends BaseCliAdapter {
  constructor(hostArg) {
    super();
    const envHost = process.env.MSTREAM_MPD_HOST;
    this.target = parseMpdHost(hostArg || envHost || '');
    this._sock = null;
    this._buf = '';
    this._queue = []; // { resolve, reject, lines: [] }
    this._active = null;
  }

  async start() {
    await this._connect();
    // Reset any prior session state so our queue mirror agrees with the daemon.
    try { await this._send('clear'); } catch (_) { /* ignore */ }
    try { await this._send('consume 0'); } catch (_) { /* ignore */ }
    try { await this._send('single 0'); } catch (_) { /* ignore */ }
    try { await this._send('repeat 0'); } catch (_) { /* ignore */ }
  }

  async stop() {
    if (this._sock) { try { this._sock.destroy(); } catch (_) { /* ignore */ } this._sock = null; }
    // Fail any in-flight commands
    if (this._active) { this._active.reject(new Error('mpd closed')); this._active = null; }
    for (const p of this._queue) { p.reject(new Error('mpd closed')); }
    this._queue = [];
  }

  _describeTarget() {
    return this.target.kind === 'unix' ? this.target.path : `${this.target.host}:${this.target.port}`;
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const sock = net.connect(connectOpts(this.target));
      let greeted = false;
      sock.setTimeout(3000);
      sock.on('data', (chunk) => {
        if (!greeted) {
          // First packet is MPD's "OK MPD <version>\n" banner
          const text = chunk.toString();
          const idx = text.indexOf('\n');
          const banner = idx >= 0 ? text.slice(0, idx) : text;
          if (!/^OK MPD /.test(banner)) {
            sock.destroy();
            return reject(new Error(`Unexpected MPD banner: ${banner}`));
          }
          greeted = true;
          sock.setTimeout(0);
          this._sock = sock;
          this._sock.on('data', (c) => this._onData(c));
          this._sock.on('close', () => {
            if (this._sock === sock) { this._sock = null; }
            if (this._active) { this._active.reject(new Error('mpd closed')); this._active = null; }
          });
          this._sock.on('error', () => {});
          winston.info(`[cli-audio:mpd] connected to ${this._describeTarget()}`);
          // Feed any buffered bytes after the banner into the parser
          const rest = idx >= 0 ? text.slice(idx + 1) : '';
          if (rest) { this._onData(Buffer.from(rest)); }
          return resolve();
        }
      });
      sock.once('error', (e) => reject(e));
      sock.once('timeout', () => { sock.destroy(); reject(new Error('mpd connect timeout')); });
    });
  }

  _onData(chunk) {
    this._buf += chunk.toString();
    while (true) {
      const nl = this._buf.indexOf('\n');
      if (nl < 0) { break; }
      const line = this._buf.slice(0, nl);
      this._buf = this._buf.slice(nl + 1);
      if (!this._active) { continue; }
      if (/^OK\b/.test(line)) {
        const out = this._active; this._active = null;
        out.resolve(out.lines);
        this._drain();
      } else if (/^ACK /.test(line)) {
        const out = this._active; this._active = null;
        out.reject(new Error(line));
        this._drain();
      } else {
        this._active.lines.push(line);
      }
    }
  }

  _drain() {
    if (this._active || this._queue.length === 0 || !this._sock || this._sock.destroyed) { return; }
    this._active = this._queue.shift();
    try {
      this._sock.write(this._active.cmd + '\n');
    } catch (e) {
      const a = this._active; this._active = null;
      a.reject(e);
      this._drain();
    }
  }

  _send(cmd) {
    return new Promise((resolve, reject) => {
      if (!this._sock || this._sock.destroyed) { return reject(new Error('mpd not connected')); }
      this._queue.push({ cmd, lines: [], resolve, reject });
      this._drain();
    });
  }

  _escape(s) {
    return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }

  _toUri(absPath) {
    // MPD accepts file:// URIs for absolute paths (0.19+).
    const p = absPath.replace(/\\/g, '/');
    if (p.startsWith('/')) { return 'file://' + p; }
    return 'file:///' + p;
  }

  _parseKV(lines) {
    const out = {};
    for (const line of lines) {
      const idx = line.indexOf(':');
      if (idx > 0) { out[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim(); }
    }
    return out;
  }

  async _loadFile(absPath) {
    await this._send('clear');
    await this._send(`add ${this._escape(this._toUri(absPath))}`);
    await this._send('play 0');
  }

  async _pause() { await this._send('pause 1'); }
  async _resume() { await this._send('pause 0'); }
  async _stop() { await this._send('stop'); }
  async _seek(seconds) { await this._send(`seekcur ${Math.max(0, Math.floor(seconds))}`); }
  async _setVolume(vol01) { await this._send(`setvol ${Math.round(Math.max(0, Math.min(1, vol01)) * 100)}`); }

  async _getPosition() {
    try {
      const kv = this._parseKV(await this._send('status'));
      const t = kv.elapsed || (kv.time ? kv.time.split(':')[0] : '0');
      return Number(t) || 0;
    } catch (_e) { return 0; }
  }

  async _getDuration() {
    try {
      const kv = this._parseKV(await this._send('status'));
      const d = kv.duration || (kv.time ? kv.time.split(':')[1] : '0');
      return Number(d) || 0;
    } catch (_e) { return 0; }
  }
}
