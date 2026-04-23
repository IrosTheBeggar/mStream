import dgram from 'node:dgram';
import os from 'node:os';
import { createRequire } from 'node:module';
import winston from 'winston';
import * as config from '../state/config.js';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');

const MULTICAST_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const CACHE_MAX_AGE_SECONDS = 1800;
// Re-announce well before max-age expires so control points don't briefly
// drop the device between announcements.
const NOTIFY_INTERVAL_MS = (CACHE_MAX_AGE_SECONDS / 2) * 1000;

// UPnP 1.1 BOOTID/CONFIGID. BOOTID must be non-decreasing across reboots and
// fit in 31 bits (< 2^31 = 2,147,483,648); Unix seconds satisfies both until
// 2038. CONFIGID is a stable id for the device description — it's effectively
// static for mStream, so a single reserved constant is fine.
const BOOT_ID = Math.floor(Date.now() / 1000);
const CONFIG_ID = 1;

let socket = null;
let notifyTimer = null;

// IPv4 addresses of interfaces we successfully joined the SSDP multicast
// group on. Populated during bind(). `sendMessages()` rotates through
// this list via setMulticastInterface() so NOTIFY / byebye announcements
// go out on every interface, not just the default route's. Empty list
// means "use whatever the socket's current default is" — matches
// single-interface hosts and the pre-multi-NIC behaviour.
let joinedInterfaces = [];

// ── Helpers ─────────────────────────────────────────────────────────────────

export function getLocalIp() {
  const addr = config.program.address;
  if (addr && addr !== '::' && addr !== '0.0.0.0') { return addr; }
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) { return iface.address; }
    }
  }
  return '127.0.0.1';
}

export function getBaseUrl() {
  if (config.program.dlna.mode === 'separate-port') {
    return `http://${getLocalIp()}:${config.program.dlna.port}`;
  }
  const proto = config.getIsHttps() ? 'https' : 'http';
  return `${proto}://${getLocalIp()}:${config.program.port}`;
}

function deviceUrl() {
  return `${getBaseUrl()}/dlna/device.xml`;
}

function uuid() {
  return config.program.dlna.uuid;
}

// ── Message builders ─────────────────────────────────────────────────────────

const SERVER_STRING = `Node/${process.version} UPnP/1.0 mStream/${packageJson.version}`;

function notifyMsg(nt, usn) {
  return [
    'NOTIFY * HTTP/1.1',
    `HOST: ${MULTICAST_ADDR}:${SSDP_PORT}`,
    `CACHE-CONTROL: max-age=${CACHE_MAX_AGE_SECONDS}`,
    `LOCATION: ${deviceUrl()}`,
    `NT: ${nt}`,
    'NTS: ssdp:alive',
    `SERVER: ${SERVER_STRING}`,
    `USN: ${usn}`,
    `BOOTID.UPNP.ORG: ${BOOT_ID}`,
    `CONFIGID.UPNP.ORG: ${CONFIG_ID}`,
    '',
    '',
  ].join('\r\n');
}

function byebyeMsg(nt, usn) {
  return [
    'NOTIFY * HTTP/1.1',
    `HOST: ${MULTICAST_ADDR}:${SSDP_PORT}`,
    `NT: ${nt}`,
    'NTS: ssdp:byebye',
    `USN: ${usn}`,
    `BOOTID.UPNP.ORG: ${BOOT_ID}`,
    `CONFIGID.UPNP.ORG: ${CONFIG_ID}`,
    '',
    '',
  ].join('\r\n');
}

function searchResponseMsg(st, usn) {
  return [
    'HTTP/1.1 200 OK',
    `CACHE-CONTROL: max-age=${CACHE_MAX_AGE_SECONDS}`,
    `DATE: ${new Date().toUTCString()}`,
    `LOCATION: ${deviceUrl()}`,
    `SERVER: ${SERVER_STRING}`,
    `ST: ${st}`,
    `USN: ${usn}`,
    'EXT:',
    `BOOTID.UPNP.ORG: ${BOOT_ID}`,
    `CONFIGID.UPNP.ORG: ${CONFIG_ID}`,
    '',
    '',
  ].join('\r\n');
}

// ── Announce / byebye ────────────────────────────────────────────────────────

function buildAliveMessages() {
  const id = uuid();
  return [
    notifyMsg('upnp:rootdevice',                                              `uuid:${id}::upnp:rootdevice`),
    notifyMsg(`uuid:${id}`,                                                   `uuid:${id}`),
    notifyMsg('urn:schemas-upnp-org:device:MediaServer:1',                   `uuid:${id}::urn:schemas-upnp-org:device:MediaServer:1`),
    notifyMsg('urn:schemas-upnp-org:service:ContentDirectory:1',             `uuid:${id}::urn:schemas-upnp-org:service:ContentDirectory:1`),
    notifyMsg('urn:schemas-upnp-org:service:ConnectionManager:1',            `uuid:${id}::urn:schemas-upnp-org:service:ConnectionManager:1`),
  ];
}

function buildByebyeMessages() {
  const id = uuid();
  return [
    byebyeMsg('upnp:rootdevice',                                              `uuid:${id}::upnp:rootdevice`),
    byebyeMsg(`uuid:${id}`,                                                   `uuid:${id}`),
    byebyeMsg('urn:schemas-upnp-org:device:MediaServer:1',                   `uuid:${id}::urn:schemas-upnp-org:device:MediaServer:1`),
    byebyeMsg('urn:schemas-upnp-org:service:ContentDirectory:1',             `uuid:${id}::urn:schemas-upnp-org:service:ContentDirectory:1`),
    byebyeMsg('urn:schemas-upnp-org:service:ConnectionManager:1',            `uuid:${id}::urn:schemas-upnp-org:service:ConnectionManager:1`),
  ];
}

function sendMessages(messages) {
  if (!socket) { return; }

  // Single-interface / no interfaces enumerated: send once over the
  // socket's default outbound interface. Preserves behaviour on hosts
  // where the multi-NIC dance isn't needed (or impossible).
  if (joinedInterfaces.length <= 1) {
    for (const msg of messages) {
      const buf = Buffer.from(msg, 'utf8');
      socket.send(buf, 0, buf.length, SSDP_PORT, MULTICAST_ADDR, (err) => {
        if (err) { winston.debug(`[dlna-ssdp] send error: ${err.message}`); }
      });
    }
    return;
  }

  // Multi-NIC host: rotate through every interface we joined the group
  // on. Without this, NOTIFY announcements leave only on the default
  // route — a renderer sitting on a non-default interface (Docker
  // bridge, secondary LAN, VPN) would never passively-discover us and
  // would be stuck waiting for M-SEARCH cycles instead.
  //
  // setMulticastInterface() isn't atomic across sends — it mutates
  // socket state and every queued send picks up the current value.
  // We send one interface's batch synchronously before switching; any
  // per-send error is logged at debug (same as the single-interface
  // path) so a dead interface doesn't block the others.
  for (const ifaceAddr of joinedInterfaces) {
    try { socket.setMulticastInterface(ifaceAddr); }
    catch (err) {
      winston.debug(`[dlna-ssdp] setMulticastInterface(${ifaceAddr}): ${err.message}`);
      continue;
    }
    for (const msg of messages) {
      const buf = Buffer.from(msg, 'utf8');
      socket.send(buf, 0, buf.length, SSDP_PORT, MULTICAST_ADDR, (err) => {
        if (err) { winston.debug(`[dlna-ssdp] send error on ${ifaceAddr}: ${err.message}`); }
      });
    }
  }
}

function sendAlive() {
  sendMessages(buildAliveMessages());
}

// ── M-SEARCH response ────────────────────────────────────────────────────────

function handleSearch(msgStr, rinfo) {
  // UPnP SSDP spec: an M-SEARCH MUST carry `MAN: "ssdp:discover"` (quoted).
  // Responding to packets without it violates the spec and (more practically)
  // means we'd reply to random multicast noise. Some enterprise network scanners
  // fire bare M-SEARCH probes looking for any SSDP responder; they don't want
  // or need our reply.
  //
  // We're liberal on the quoting (some sloppy clients omit it) but strict
  // on the rest of the line — trailing garbage like `"ssdp:discoverexploit`
  // must not match. `\s*$` with /m anchors to end-of-line.
  const manMatch = msgStr.match(/^MAN:\s*"?ssdp:discover"?\s*$/im);
  if (!manMatch) { return; }

  const stMatch = msgStr.match(/^ST:\s*(.+)$/im);
  if (!stMatch) { return; }
  const st = stMatch[1].trim();
  const id = uuid();

  const matches = {
    'ssdp:all':                                             [
      ['upnp:rootdevice',                                `uuid:${id}::upnp:rootdevice`],
      [`uuid:${id}`,                                     `uuid:${id}`],
      ['urn:schemas-upnp-org:device:MediaServer:1',     `uuid:${id}::urn:schemas-upnp-org:device:MediaServer:1`],
      ['urn:schemas-upnp-org:service:ContentDirectory:1',  `uuid:${id}::urn:schemas-upnp-org:service:ContentDirectory:1`],
      ['urn:schemas-upnp-org:service:ConnectionManager:1', `uuid:${id}::urn:schemas-upnp-org:service:ConnectionManager:1`],
    ],
    'upnp:rootdevice':                                      [['upnp:rootdevice', `uuid:${id}::upnp:rootdevice`]],
    [`uuid:${id}`]:                                         [[`uuid:${id}`, `uuid:${id}`]],
    'urn:schemas-upnp-org:device:MediaServer:1':           [['urn:schemas-upnp-org:device:MediaServer:1', `uuid:${id}::urn:schemas-upnp-org:device:MediaServer:1`]],
    'urn:schemas-upnp-org:service:ContentDirectory:1':     [['urn:schemas-upnp-org:service:ContentDirectory:1', `uuid:${id}::urn:schemas-upnp-org:service:ContentDirectory:1`]],
    'urn:schemas-upnp-org:service:ConnectionManager:1':    [['urn:schemas-upnp-org:service:ConnectionManager:1', `uuid:${id}::urn:schemas-upnp-org:service:ConnectionManager:1`]],
  };

  const pairs = matches[st];
  if (!pairs) { return; }

  // Honor MX: delay responses by a random 0..MX seconds, then stagger by 50ms each
  const mxMatch = msgStr.match(/^MX:\s*(\d+)/im);
  const mx = Math.max(1, parseInt(mxMatch ? mxMatch[1] : '1', 10));
  let delay = Math.floor(Math.random() * mx * 1000);
  for (const [respSt, respUsn] of pairs) {
    const msg = searchResponseMsg(respSt, respUsn);
    const buf = Buffer.from(msg, 'utf8');
    setTimeout(() => {
      if (!socket) { return; }
      socket.send(buf, 0, buf.length, rinfo.port, rinfo.address, (err) => {
        if (err) { winston.debug(`[dlna-ssdp] search response error: ${err.message}`); }
      });
    }, delay);
    delay += 50;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export function start() {
  if (socket) { return; }

  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  socket = sock;

  sock.on('error', (err) => {
    winston.error(`[dlna-ssdp] Socket error: ${err.message}`);
    stop();
  });

  sock.on('message', (msg, rinfo) => {
    const str = msg.toString('utf8');
    if (str.startsWith('M-SEARCH')) { handleSearch(str, rinfo); }
  });

  sock.bind(SSDP_PORT, () => {
    // Guard: if stop() was called before bind completed, don't proceed
    if (socket !== sock) { return; }
    try {
      // Join the multicast group on every non-internal IPv4 interface.
      // Without explicit per-interface joins, Node binds the membership
      // to the default route's interface only — on multi-NIC hosts
      // (Docker bridge + LAN, VPN + LAN, two-NIC servers, WSL) renderers
      // on non-default interfaces never see our NOTIFY/M-SEARCH traffic.
      //
      // Failure on any one interface is non-fatal (EADDRINUSE can happen
      // when two processes share the group; some interface types don't
      // support multicast). We log at debug and keep going. If zero joins
      // succeed, fall back to the bare form — matches previous behaviour.
      const ifaces = os.networkInterfaces();
      joinedInterfaces = [];
      for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name]) {
          if (iface.family !== 'IPv4' || iface.internal) { continue; }
          try {
            sock.addMembership(MULTICAST_ADDR, iface.address);
            joinedInterfaces.push(iface.address);
          } catch (err) {
            winston.debug(`[dlna-ssdp] addMembership(${iface.address}): ${err.message}`);
          }
        }
      }
      if (joinedInterfaces.length === 0) {
        // Nothing enumerated or every per-interface join failed — last resort.
        sock.addMembership(MULTICAST_ADDR);
      }
      sock.setMulticastTTL(4);
    } catch (err) {
      winston.warn(`[dlna-ssdp] Multicast setup: ${err.message}`);
    }
    sendAlive();
    winston.info(`[dlna-ssdp] Listening on ${getLocalIp()}:${SSDP_PORT}`);
  });

  notifyTimer = setInterval(sendAlive, NOTIFY_INTERVAL_MS);
}

export function stop() {
  if (notifyTimer) { clearInterval(notifyTimer); notifyTimer = null; }
  if (!socket) { joinedInterfaces = []; return; }

  const sock = socket;
  socket = null; // prevent any new sends from start() or timers

  const messages = buildByebyeMessages();
  let remaining = messages.length;

  function closeWhenDone() {
    if (--remaining === 0) {
      try { sock.close(); } catch (_) {}
      joinedInterfaces = [];
      winston.info('[dlna-ssdp] Stopped');
    }
  }

  // Mirror sendMessages()'s interface fan-out for the byebye batch so
  // renderers on every interface see us leave — otherwise stale entries
  // linger in their UI until CACHE-CONTROL max-age expires.
  const ifaces = joinedInterfaces.length > 1 ? joinedInterfaces : [null];
  remaining = messages.length * ifaces.length;
  for (const ifaceAddr of ifaces) {
    if (ifaceAddr) {
      try { sock.setMulticastInterface(ifaceAddr); }
      catch (_) { /* fall through, still send on current default */ }
    }
    for (const msg of messages) {
      const buf = Buffer.from(msg, 'utf8');
      sock.send(buf, 0, buf.length, SSDP_PORT, MULTICAST_ADDR, () => closeWhenDone());
    }
  }
}
