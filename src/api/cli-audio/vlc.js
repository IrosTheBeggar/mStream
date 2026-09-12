/**
 * VlcAdapter — controls VLC via its rc (remote-control) text interface.
 *
 * Launches `vlc --intf rc --rc-host 127.0.0.1:PORT` on a random free port and
 * sends single-line text commands over TCP. VLC replies with multi-line ASCII;
 * we consume output line-by-line but don't pair requests to responses (the rc
 * interface doesn't tag replies), so read-back commands parse the latest line
 * matching a known prefix.
 */

import net from 'net';
import child_process from 'child_process';
import winston from 'winston';
import { BaseCliAdapter } from './base.js';

function pickPort() {
  return 24000 + Math.floor(Math.random() * 1000);
}

export class VlcAdapter extends BaseCliAdapter {
  constructor(binary = 'vlc') {
    super();
    this.binary = binary;
    this._port = pickPort();
    this._proc = null;
    this._sock = null;
    this._buf = '';
    this._lastLines = [];
  }

  async start() {
    this._proc = child_process.spawn(this.binary, [
      '--intf', 'rc',
      '--rc-host', `127.0.0.1:${this._port}`,
      '--no-video',
      '--quiet',
      '--no-random',
      '--play-and-stop',
    ], { stdio: 'ignore', detached: false });

    this._proc.on('error', (err) => {
      winston.error(`[cli-audio:vlc] process error: ${err.message}`);
      this._proc = null;
    });

    this._proc.on('exit', (code) => {
      winston.info(`[cli-audio:vlc] exited (code ${code})`);
      this._proc = null;
      if (this._sock) { try { this._sock.destroy(); } catch (_) { /* closed */ } this._sock = null; }
    });

    await this._waitForSocket();
  }

  async stop() {
    if (this._sock) { try { this._sock.destroy(); } catch (_) { /* closed */ } this._sock = null; }
    if (this._proc) { try { this._proc.kill('SIGTERM'); } catch (_) { /* dead */ } this._proc = null; }
  }

  _waitForSocket() {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const tryConnect = () => {
        if (!this._proc) { return reject(new Error('vlc not running')); }
        const s = net.connect(this._port, '127.0.0.1');
        s.once('connect', () => {
          this._sock = s;
          this._buf = '';
          s.on('data', (chunk) => this._onData(chunk));
          s.on('close', () => { if (this._sock === s) { this._sock = null; } });
          s.on('error', () => {});
          winston.info(`[cli-audio:vlc] rc connected on port ${this._port}`);
          resolve();
        });
        s.once('error', () => {
          s.destroy();
          attempts += 1;
          if (attempts > 20) { return reject(new Error('vlc rc port did not open')); }
          setTimeout(tryConnect, 250);
        });
      };
      setTimeout(tryConnect, 500);
    });
  }

  _onData(chunk) {
    this._buf += chunk.toString();
    const lines = this._buf.split('\n');
    this._buf = lines.pop();
    for (const line of lines) {
      const t = line.replace(/\r$/, '').trim();
      if (t) { this._lastLines.push(t); }
    }
    if (this._lastLines.length > 40) {
      this._lastLines = this._lastLines.slice(-40);
    }
  }

  _send(cmd) {
    return new Promise((resolve, reject) => {
      if (!this._sock || this._sock.destroyed) { return reject(new Error('vlc rc not connected')); }
      try {
        this._sock.write(cmd + '\n');
        resolve();
      } catch (e) { reject(e); }
    });
  }

  _wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async _readNumeric(cmd) {
    this._lastLines = [];
    await this._send(cmd);
    await this._wait(120);
    for (let i = this._lastLines.length - 1; i >= 0; i--) {
      const m = this._lastLines[i].match(/-?\d+(\.\d+)?/);
      if (m) { return Number(m[0]); }
    }
    return 0;
  }

  async _loadFile(absPath) {
    await this._send('clear');
    await this._send(`add ${absPath}`);
    this.duration = await this._readNumeric('get_length');
  }

  async _pause() { await this._send('pause'); }
  async _resume() { await this._send('play'); }
  async _stop() { await this._send('stop'); }
  async _seek(seconds) { await this._send(`seek ${Math.floor(seconds)}`); }
  async _setVolume(vol01) { await this._send(`volume ${Math.round(vol01 * 320)}`); }

  _getPosition() { return this._readNumeric('get_time'); }
  async _getDuration() {
    const d = await this._readNumeric('get_length');
    return d || this.duration;
  }
}
