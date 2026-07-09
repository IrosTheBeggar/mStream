import dgram from 'node:dgram';
import os from 'node:os';
import winston from 'winston';
import * as config from '../state/config.js';

// Static JSON import (not createRequire) so the Bun single-binary bundle can
// resolve it — a runtime require() isn't bundled and dies inside bunfs.
import packageJson from '../../package.json' with { type: 'json' };

// ── mDNS / DNS-SD advertiser ──────────────────────────────────────────────────
//
// Advertises the mStream API as a `_mstream._tcp` service over multicast DNS so
// LAN clients (e.g. the portable mStream player) can find the server with zero
// configuration — no IP typing. This is the discovery half of the player's
// pairing story; it carries metadata only and touches no routes or auth.
//
// Hand-rolled with raw dgram (no new dependency), mirroring the SSDP module in
// ../dlna/ssdp.js: same multi-NIC group-join + interface fan-out, same
// winston `[mdns]` log tags, same non-fatal failure handling (a bind/socket
// error disables discovery; it never takes the server down).
//
// Coexistence: hosts often already run an mDNS responder (Bonjour on macOS,
// Avahi on Linux) that owns UDP 5353. We bind with SO_REUSEADDR (and
// SO_REUSEPORT off Windows) and join the multicast group, so multicast queries
// are delivered to every joined socket — we answer alongside the OS responder
// for our own service type rather than fighting it for the port. On Windows,
// SO_REUSEADDR already grants shared binding.

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;

// RFC 6762 §10 TTL guidance: records that point at a host name (A, SRV) use a
// short 120s TTL so stale addresses age out quickly; shared/metadata records
// (PTR, TXT) use the longer 75-minute TTL.
const TTL_HOST = 120;
const TTL_SHARED = 4500;
// Re-announce comfortably inside TTL_HOST so passive listeners' caches stay
// warm between the player's active queries. One small packet per interval.
const ANNOUNCE_INTERVAL_MS = 60 * 1000;

// DNS record types / classes
const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_SRV = 33;
const CLASS_IN = 1;
const CLASS_IN_FLUSH = 0x8001; // IN + cache-flush bit, for our unique records

const SERVICE_LABELS = ['_mstream', '_tcp', 'local'];
const DNSSD_META_LABELS = ['_services', '_dns-sd', '_udp', 'local'];

let socket = null;
let announceTimer = null;
let joinedInterfaces = [];
let info = null; // cached descriptor, refreshed on each announce

// ── Service descriptor ─────────────────────────────────────────────────────────

function getIpv4Addresses() {
  const addr = config.program.address;
  if (addr && addr !== '::' && addr !== '0.0.0.0') { return [addr]; }
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) { out.push(iface.address); }
    }
  }
  return out.length ? out : ['127.0.0.1'];
}

// DNS labels are limited to 63 octets (RFC 1035 §2.3.4). The instance name is
// the only operator/hostname-controlled label we emit, so clamp it on a UTF-8
// code-point boundary — a long friendly `name` or `os.hostname()` must never
// make encodeName() throw on the announce path and take the server down.
export function clampLabel(str, maxBytes = 63) {
  if (typeof str !== 'string') { str = String(str ?? ''); } // a guard must never throw
  if (Buffer.byteLength(str, 'utf8') <= maxBytes) { return str; }
  let out = '';
  for (const ch of str) { // iterates by code point — never splits a character
    if (Buffer.byteLength(out + ch, 'utf8') > maxBytes) { break; }
    out += ch;
  }
  return out;
}

// Build the descriptor the records are generated from. Kept as plain data so
// the wire-format builders below are pure and unit-testable without config.
export function gatherInfo() {
  const mdns = config.program.discovery.mdns;
  const instanceName = clampLabel((mdns.name && mdns.name.trim()) || os.hostname() || 'mStream');
  const instanceId = mdns.instanceId || 'unknown';
  // A stable, conflict-avoiding target host so we don't claim the OS
  // responder's own `<hostname>.local`. The SRV record points clients here and
  // the A records below resolve it.
  const id8 = instanceId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase() || 'server';
  return {
    instanceName,
    instanceId,
    targetHost: `mstream-${id8}`,
    scheme: config.getIsHttps() ? 'https' : 'http',
    port: config.program.port,
    path: '/',
    version: packageJson.version,
    ips: getIpv4Addresses(),
    // Optional public URL so a portable player can reach home from anywhere —
    // reuse the relay URL the operator already configured if present.
    publicUrl: (config.program.rpn && config.program.rpn.url) ? config.program.rpn.url : '',
    // Whether the Iroh remote-access tunnel is enabled. Advertised (capability
    // flag only — no secret) so a LAN client like the app's Quick Connect can
    // surface just the servers it can pair with for roaming. mDNS and Iroh are
    // independent configs, so this is simply absent when Iroh is off.
    irohEnabled: !!(config.program.iroh && config.program.iroh.enabled === true),
  };
}

function instanceLabels(i) { return [i.instanceName, '_mstream', '_tcp', 'local']; }
function targetLabels(i) { return [i.targetHost, 'local']; }

function txtEntries(i) {
  const entries = [
    `name=${i.instanceName}`,
    `id=${i.instanceId}`,
    `v=${i.version}`,
    `scheme=${i.scheme}`,
    `port=${i.port}`,
    `path=${i.path}`,
    `api=v1`,
    `auth=apikey,jwt`,
  ];
  // Capability flag: the Iroh remote-access tunnel is available for pairing.
  if (i.irohEnabled) { entries.push(`iroh=1`); }
  if (i.publicUrl) { entries.push(`pub=${i.publicUrl}`); }
  return entries;
}

// ── DNS wire format (pure, exported for tests) ─────────────────────────────────

export function encodeName(labels) {
  const parts = [];
  for (const label of labels) {
    const buf = Buffer.from(label, 'utf8');
    if (buf.length > 63) { throw new Error(`mdns: label exceeds 63 bytes: ${label}`); }
    parts.push(Buffer.from([buf.length]), buf);
  }
  parts.push(Buffer.from([0])); // root label terminator
  return Buffer.concat(parts);
}

function encodeTxt(entries) {
  const parts = [];
  for (const entry of entries) {
    const buf = Buffer.from(entry, 'utf8').subarray(0, 255); // each string <=255 bytes
    parts.push(Buffer.from([buf.length]), buf);
  }
  if (parts.length === 0) { parts.push(Buffer.from([0])); } // TXT must be non-empty
  return Buffer.concat(parts);
}

function ipv4Rdata(ip) {
  return Buffer.from(ip.split('.').map((n) => parseInt(n, 10) & 0xff));
}

function srvRdata(i) {
  const head = Buffer.alloc(6); // priority(2) weight(2) port(2)
  head.writeUInt16BE(0, 0);
  head.writeUInt16BE(0, 2);
  head.writeUInt16BE(i.port, 4);
  return Buffer.concat([head, encodeName(targetLabels(i))]);
}

function record(nameLabels, type, klass, ttl, rdata) {
  const name = encodeName(nameLabels);
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(klass, 2);
  head.writeUInt32BE(ttl, 4);
  head.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([name, head, rdata]);
}

function message(answers) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); // ID 0 (mDNS)
  header.writeUInt16BE(0x8400, 2); // QR=1 (response), AA=1 (authoritative)
  header.writeUInt16BE(0, 4); // QDCOUNT
  header.writeUInt16BE(answers.length, 6); // ANCOUNT
  header.writeUInt16BE(0, 8); // NSCOUNT
  header.writeUInt16BE(0, 10); // ARCOUNT
  return Buffer.concat([header, ...answers]);
}

// Full announcement: PTR (service + DNS-SD meta), SRV, TXT, and an A record per
// address. `ttl=0` produces a goodbye packet.
export function buildAnnouncementPacket(i, { goodbye = false } = {}) {
  const shared = goodbye ? 0 : TTL_SHARED;
  const host = goodbye ? 0 : TTL_HOST;
  const answers = [
    record(SERVICE_LABELS, TYPE_PTR, CLASS_IN, shared, encodeName(instanceLabels(i))),
    record(DNSSD_META_LABELS, TYPE_PTR, CLASS_IN, shared, encodeName(SERVICE_LABELS)),
    record(instanceLabels(i), TYPE_SRV, CLASS_IN_FLUSH, host, srvRdata(i)),
    record(instanceLabels(i), TYPE_TXT, CLASS_IN_FLUSH, shared, encodeTxt(txtEntries(i))),
  ];
  for (const ip of i.ips) {
    answers.push(record(targetLabels(i), TYPE_A, CLASS_IN_FLUSH, host, ipv4Rdata(ip)));
  }
  return message(answers);
}

// Read a (possibly compressed) DNS name starting at `off`. Returns the
// lowercased dotted name and the offset just past the name in the question.
function readName(msg, off) {
  const labels = [];
  let jumped = false;
  let next = off;
  let pos = off;
  let guard = 0;
  while (guard++ < 128) {
    const len = msg[pos];
    if (len === undefined) { break; }
    if ((len & 0xc0) === 0xc0) { // compression pointer
      if (!jumped) { next = pos + 2; }
      pos = ((len & 0x3f) << 8) | (msg[pos + 1] ?? 0);
      jumped = true;
      continue;
    }
    if (len === 0) { if (!jumped) { next = pos + 1; } break; }
    labels.push(msg.toString('utf8', pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  return { name: labels.join('.').toLowerCase(), next };
}

export function parseQuestions(msg) {
  if (!Buffer.isBuffer(msg) || msg.length < 12) { return []; }
  const qd = msg.readUInt16BE(4);
  let off = 12;
  const questions = [];
  for (let q = 0; q < qd; q++) {
    const { name, next } = readName(msg, off);
    if (next + 4 > msg.length) { break; }
    const type = msg.readUInt16BE(next);
    off = next + 4;
    questions.push({ name, type });
  }
  return questions;
}

// True if any question targets one of the names we own.
export function matchesOurNames(questions, i) {
  const ours = new Set([
    SERVICE_LABELS.join('.'),
    DNSSD_META_LABELS.join('.'),
    instanceLabels(i).join('.').toLowerCase(),
    targetLabels(i).join('.').toLowerCase(),
  ]);
  return questions.some((q) => ours.has(q.name));
}

// ── Socket send (multi-NIC fan-out, mirrors ssdp.js) ───────────────────────────

function sendPacket(buf) {
  if (!socket) { return; }
  if (joinedInterfaces.length <= 1) {
    socket.send(buf, 0, buf.length, MDNS_PORT, MDNS_ADDR, (err) => {
      if (err) { winston.debug(`[mdns] send error: ${err.message}`); }
    });
    return;
  }
  for (const ifaceAddr of joinedInterfaces) {
    try { socket.setMulticastInterface(ifaceAddr); }
    catch (err) { winston.debug(`[mdns] setMulticastInterface(${ifaceAddr}): ${err.message}`); continue; }
    socket.send(buf, 0, buf.length, MDNS_PORT, MDNS_ADDR, (err) => {
      if (err) { winston.debug(`[mdns] send error on ${ifaceAddr}: ${err.message}`); }
    });
  }
}

// Exported for tests; not part of the public surface. Never let a record-building
// error (e.g. an un-encodable label) escape into the announce timer or bind
// callback — an uncaught throw there takes the whole server down. Discovery is
// best-effort: skip this round and warn.
export function announce() {
  try {
    info = gatherInfo();
    sendPacket(buildAnnouncementPacket(info));
  } catch (err) {
    winston.warn(`[mdns] announce skipped: ${err.message}`);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function start() {
  if (socket) { return; }
  if (!config.program.discovery || !config.program.discovery.mdns.enabled) { return; }

  const opts = { type: 'udp4', reuseAddr: true };
  // SO_REUSEPORT lets us share 5353 with the OS responder where it exists;
  // it's unsupported on Windows, where SO_REUSEADDR already allows sharing.
  if (process.platform !== 'win32') { opts.reusePort = true; }

  let sock;
  try {
    sock = dgram.createSocket(opts);
  } catch (err) {
    winston.warn(`[mdns] Failed to create socket, discovery disabled: ${err.message}`);
    return;
  }
  socket = sock;

  sock.on('error', (err) => {
    winston.warn(`[mdns] Socket error, discovery disabled: ${err.message}`);
    stop();
  });

  sock.on('message', (msg) => {
    try {
      const questions = parseQuestions(msg);
      if (questions.length && info && matchesOurNames(questions, info)) {
        sendPacket(buildAnnouncementPacket(info));
      }
    } catch (err) {
      winston.debug(`[mdns] message handling error: ${err.message}`);
    }
  });

  sock.bind(MDNS_PORT, () => {
    // stop() may have run before bind completed.
    if (socket !== sock) { return; }
    try {
      const ifaces = os.networkInterfaces();
      joinedInterfaces = [];
      for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name]) {
          if (iface.family !== 'IPv4' || iface.internal) { continue; }
          try { sock.addMembership(MDNS_ADDR, iface.address); joinedInterfaces.push(iface.address); }
          catch (err) { winston.debug(`[mdns] addMembership(${iface.address}): ${err.message}`); }
        }
      }
      if (joinedInterfaces.length === 0) { sock.addMembership(MDNS_ADDR); }
      sock.setMulticastTTL(255); // RFC 6762: mDNS packets use IP TTL 255
    } catch (err) {
      winston.warn(`[mdns] Multicast setup: ${err.message}`);
    }
    // Two announcements ~1s apart (RFC 6762 §8.3) so a client that misses the
    // first still sees us promptly.
    announce();
    setTimeout(() => { if (socket === sock) { announce(); } }, 1000);
    winston.info(`[mdns] Advertising _mstream._tcp on ${getIpv4Addresses().join(', ')}:${config.program.port}`);
  });

  announceTimer = setInterval(announce, ANNOUNCE_INTERVAL_MS);
}

export function stop() {
  if (announceTimer) { clearInterval(announceTimer); announceTimer = null; }
  if (!socket) { joinedInterfaces = []; return; }

  const sock = socket;
  socket = null; // block any further sends from timers/handlers

  const ifaceSnapshot = joinedInterfaces;
  joinedInterfaces = [];

  // Announce a goodbye (TTL 0) so clients drop us immediately instead of
  // waiting for the cache to expire.
  try {
    const goodbye = buildAnnouncementPacket(info || gatherInfo(), { goodbye: true });
    const ifaces = ifaceSnapshot.length > 1 ? ifaceSnapshot : [null];
    for (const ifaceAddr of ifaces) {
      if (ifaceAddr) { try { sock.setMulticastInterface(ifaceAddr); } catch (_) { /* use default */ } }
      sock.send(goodbye, 0, goodbye.length, MDNS_PORT, MDNS_ADDR, () => {});
    }
  } catch (err) {
    winston.debug(`[mdns] goodbye error: ${err.message}`);
  }

  // Give the goodbye datagram(s) a moment to flush before closing the socket.
  setTimeout(() => {
    try { sock.close(); } catch (_) { /* already closed */ }
    winston.info('[mdns] Stopped');
  }, 100);
}
