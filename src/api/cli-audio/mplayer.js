/**
 * MplayerAdapter — controls mplayer via its `-slave` mode over stdin/stdout.
 *
 * MPlayer reads text commands from stdin and emits answers on stdout in the
 * form "ANS_<name>=<value>". We keep a rolling buffer of answers so position
 * and length reads can pull the most recent value without needing per-command
 * correlation (there's no request-id mechanism).
 */

import child_process from 'child_process';
import WebError from '../../util/web-error.js';
import winston from 'winston';
import { BaseCliAdapter } from './base.js';

export class MplayerAdapter extends BaseCliAdapter {
  constructor(binary = 'mplayer') {
    super('mplayer');
    this.binary = binary;
    this._proc = null;
    this._stdoutBuf = '';
    this._answers = new Map();
  }

  async start() {
    this._proc = child_process.spawn(this.binary, [
      '-slave',
      '-quiet',
      '-idle',
      '-really-quiet',
      '-msglevel', 'all=0:global=4',
      '-nolirc',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    this._proc.on('error', (err) => {
      winston.error(`[cli-audio:mplayer] process error: ${err.message}`);
      this._proc = null;
    });

    this._proc.on('exit', (code) => {
      winston.info(`[cli-audio:mplayer] exited (code ${code})`);
      this._proc = null;
    });

    this._proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    this._proc.stderr.on('data', () => {});

    await new Promise((r) => setTimeout(r, 300));
    winston.info('[cli-audio:mplayer] started');
  }

  async stop() {
    if (this._proc) {
      try { this._proc.stdin.write('quit\n'); } catch (_) { /* ignore */ }
      try { this._proc.kill('SIGTERM'); } catch (_) { /* ignore */ }
      this._proc = null;
    }
  }

  _onStdout(chunk) {
    this._stdoutBuf += chunk.toString();
    const lines = this._stdoutBuf.split('\n');
    this._stdoutBuf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      const m = t.match(/^ANS_([A-Za-z0-9_]+)=(.*)$/);
      if (m) { this._answers.set(m[1], m[2]); }
      if (/EOF code:/.test(t) || /GLOBAL: EOF/.test(t)) {
        this._onTrackEnded().catch(() => {});
      }
    }
  }

  _send(cmd) {
    if (!this._proc || !this._proc.stdin.writable) {
      throw new WebError('mplayer not running', 503);
    }
    this._proc.stdin.write(cmd + '\n');
  }

  _wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async _ask(property, readKey, timeoutMs = 400) {
    this._answers.delete(readKey);
    this._send(`pausing_keep_force get_property ${property}`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this._answers.has(readKey)) {
        const v = this._answers.get(readKey);
        return Number(v);
      }
      await this._wait(40);
    }
    return 0;
  }

  async _loadFile(absPath) {
    const quoted = absPath.replace(/"/g, '\\"');
    this._send(`loadfile "${quoted}" 0`);
  }

  async _pause() { this._send('pause'); }
  async _resume() { this._send('pause'); }
  async _stop() { this._send('stop'); }
  async _seek(seconds) { this._send(`seek ${Math.floor(seconds)} 2`); }
  async _setVolume(vol01) { this._send(`volume ${Math.round(vol01 * 100)} 1`); }

  _getPosition() { return this._ask('time_pos', 'time_pos'); }
  _getDuration() { return this._ask('length', 'length'); }
}
