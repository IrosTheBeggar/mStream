// tray-status.json: the facts the desktop launcher shows on its tray icon
// and menu WITHOUT a session — today one number, the federation requests
// waiting on the operator. Same channel as update-check.js's
// update-status.json: a file in the data home the launcher re-reads on its
// minute tick and right after each boot. Nothing here touches the auth
// wall — the launcher is by construction the operator's own process on the
// server's own machine, and the file carries no more than the admin
// panel's Requests badge does.
//
// Written at boot and from every transition that changes a fact (the
// federation-requests engine kicks it, so does the live federation toggle),
// and once per requests sweep as the catch-all for everything else (a
// config edit, a row moved by hand). Only a CHANGE writes, so an idle
// server never touches the file.
import fs from 'fs/promises';
import path from 'path';
import winston from 'winston';
import * as config from '../state/config.js';
import * as reqDb from '../db/federation-requests.js';
import { userDataHome } from './esm-helpers.js';
import { writeJsonAtomic } from './atomic-json.js';

export function trayStatusFilePath() {
  return path.join(userDataHome(), 'tray-status.json');
}

// Inbound federation requests awaiting the operator: what server-info's
// `federationInbox` shows an admin (the panel's Requests badge), gated the
// same way minus the who-is-asking check. 0 when federation is off, or
// when the admin API is locked — the room the tray line opens would only
// show its gate, and the tray must not nag about something the operator
// cannot act on from there.
export function federationInbox() {
  const program = config.program;
  if (!program || program.lockAdmin === true || program.federation?.enabled !== true) { return 0; }
  return reqDb.countPendingInbound();
}

// The document, minus the timestamp. One flat object of plain numbers and
// booleans — the launcher's parser (rust-launcher paths.rs
// parse_tray_status) tolerates missing keys, never extra ones failing it.
export function collect() {
  return { federationInbox: federationInbox() };
}

let last = null; // the facts as last written by this process

// Recompute the facts and rewrite the file when they changed — always on
// the first call of a process life, so a stale file from the previous run
// is refreshed even when nothing differs. Resolves true when a write
// landed. `file` overrides the destination (tests).
export async function refresh(reason = '', { file = null } = {}) {
  let facts;
  try {
    facts = collect();
  } catch (err) {
    winston.warn(`[tray-status] could not collect (${reason || 'refresh'}): ${err.message}`);
    return false;
  }
  if (last && Object.keys(facts).every((k) => last[k] === facts[k])) { return false; }
  // Claim the facts before the await: two transitions in the same tick
  // must not both decide to write. A failed write releases the claim so
  // the next kick tries again.
  last = facts;
  const target = file || trayStatusFilePath();
  try {
    // The data home may not exist yet: a server whose storage dirs all
    // point elsewhere (a scratch config, a first boot before the launcher
    // ever ran) has nothing else creating it, and the atomic writer
    // creates no directories.
    await fs.mkdir(path.dirname(target), { recursive: true });
    await writeJsonAtomic(target, { ...facts, updatedAt: new Date().toISOString() });
    if (reason) { winston.info(`[tray-status] ${reason}: federationInbox=${facts.federationInbox}`); }
    return true;
  } catch (err) {
    last = null;
    winston.warn(`[tray-status] could not write ${target}: ${err.message}`);
    return false;
  }
}

// Fire-and-forget for the engine's transitions: the caller's own work
// never waits on, or fails because of, the tray file.
export function kick(reason) {
  refresh(reason).catch((err) => winston.warn(`[tray-status] ${reason}: ${err.message}`));
}

export function resetForTests() {
  last = null;
}
