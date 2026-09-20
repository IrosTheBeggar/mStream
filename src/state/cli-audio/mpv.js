/**
 * MpvAdapter — controls mpv via its JSON IPC socket.
 *
 * Launches mpv in idle mode with --input-ipc-server pointed at a Unix socket
 * (or named pipe on Windows). Commands are sent as one JSON object per line;
 * responses echo the originating request_id. Queue is managed in Node.js
 * (BaseCliAdapter) but we use mpv's native `loadfile` / `playlist-clear` to
 * pipe files into the player.
 */

import net from 'net';
import path from 'path';
import os from 'os';
import fs from 'fs';
import child_process from 'child_process';
import winston from 'winston';
import { BaseCliAdapter } from './base.js';

function socketPath() {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\mpv-mstream-${process.pid}`;
  }
  return path.join(os.tmpdir(), `mpv-mstream-${process.pid}.sock`);
}

export class MpvAdapter extends BaseCliAdapter {
  constructor(binary = 'mpv') {
    super();
    this.binary = binary;
    this._sockPath = socketPath();
    this._proc = null;
    this._sock = null;
    this._buf = '';
    this._reqId = 1;
    this._pending = new Map();
    this._connectRetries = 0;
  }

  async start() {
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(this._sockPath); } catch (_) { /* no stale socket */ }
    }

    this._proc = child_process.spawn(this.binary, [
      '--idle=yes',
      '--no-video',
      '--no-terminal',
      '--really-quiet',
      '--gapless-audio=yes',
      `--input-ipc-server=${this._sockPath}`,
    ], { stdio: 'ignore', detached: false });

    this._proc.on('error', (err) => {
      winston.error(`[cli-audio:mpv] process error: ${err.message}`);
      this._proc = null;
    });

    this._proc.on('exit', (code) => {
      winston.info(`[cli-audio:mpv] exited (code ${code})`);
      this._proc = null;
      if (this._sock) { try { this._sock.destroy(); } catch (_) { /* already closed */ } this._sock = null; }
      for (const [id, p] of this._pending) {
        clearTimeout(p.timer);
        p.reject(new Error('mpv exited'));
        this._pending.delete(id);
      }
    });

    this._connectRetries = 0;
    await this._waitForIpc();
  }

  async stop() {
    if (this._sock) { try { this._sock.destroy(); } catch (_) { /* closed */ } this._sock = null; }
    if (this._proc) { try { this._proc.kill('SIGTERM'); } catch (_) { /* dead */ } this._proc = null; }
  }

  _waitForIpc() {
    return new Promise((resolve, reject) => {
      const tryConnect = () => {
        if (!this._proc) { return reject(new Error('mpv process not running')); }
        const sock = net.connect(this._sockPath);
        sock.once('connect', () => {
          this._sock = sock;
          this._buf = '';
          sock.on('data', (chunk) => this._onSockData(chunk));
          sock.on('close', () => {
            if (this._sock === sock) { this._sock = null; }
          });
          sock.on('error', () => {});
          winston.info('[cli-audio:mpv] IPC connected');
          resolve();
        });
        sock.once('error', () => {
          sock.destroy();
          if (this._connectRetries >= 12) {
            return reject(new Error('mpv IPC socket did not appear'));
          }
          this._connectRetries += 1;
          setTimeout(tryConnect, 250);
        });
      };
      setTimeout(tryConnect, 400);
    });
  }

  _onSockData(chunk) {
    this._buf += chunk.toString();
    const lines = this._buf.split('\n');
    this._buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t) { continue; }
      try { this._onMessage(JSON.parse(t)); } catch (_) { /* bad JSON */ }
    }
  }

  _onMessage(msg) {
    if (msg.request_id !== undefined) {
      const p = this._pending.get(msg.request_id);
      if (!p) { return; }
      this._pending.delete(msg.request_id);
      clearTimeout(p.timer);
      if (msg.error === 'success') {
        p.resolve(msg.data !== undefined ? msg.data : null);
      } else {
        p.reject(new Error(msg.error || 'mpv error'));
      }
      return;
    }
    if (msg.event === 'end-file' && msg.reason === 'eof') {
      this._onTrackEnded().catch(() => {});
    }
  }

  _command(args, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      if (!this._sock || this._sock.destroyed) {
        return reject(new Error('mpv IPC not connected'));
      }
      const id = this._reqId++;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error('mpv IPC timeout'));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      try {
        this._sock.write(JSON.stringify({ command: args, request_id: id }) + '\n');
      } catch (e) {
        this._pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  async _loadFile(absPath) {
    await this._command(['loadfile', absPath, 'replace']);
  }

  async _pause() { await this._command(['set_property', 'pause', true]); }
  async _resume() { await this._command(['set_property', 'pause', false]); }
  async _stop() { await this._command(['stop']); }
  async _seek(seconds) { await this._command(['seek', seconds, 'absolute']); }
  async _setVolume(vol01) { await this._command(['set_property', 'volume', vol01 * 100]); }

  async _getPosition() {
    try { return await this._command(['get_property', 'time-pos']); }
    catch (_e) { return 0; }
  }

  async _getDuration() {
    try { return await this._command(['get_property', 'duration']); }
    catch (_e) { return 0; }
  }
}
