import { BlockList } from 'net';
import winston from 'winston';
import * as config from '../state/config.js';

// Application-level IP gate for the admin surface. Backs the 4-mode
// `config.program.adminAccess.mode`:
//   'all'       — admin reachable from anywhere (isAdminAllowed always true).
//   'none'      — admin disabled entirely (always false). The derived
//                 config.program.lockAdmin flag already short-circuits the
//                 405/page-disabled paths; this is belt-and-braces.
//   'localhost' — only loopback IPs (127.0.0.0/8 + ::1).
//   'whitelist' — only IPs/CIDRs listed in config.program.adminAccess.whitelist.
//
// The gate is a live middleware read — config is consulted fresh on every
// call so the admin API/UI can switch modes without a reboot. The built
// net.BlockList is cached, keyed on the serialized whitelist, so we don't
// rebuild it on every request; it rebuilds when the whitelist changes or
// when invalidateWhitelistCache() is called by the write helper.

// Cached BlockList for 'whitelist' mode + the key it was built from.
let cachedWhitelistBlockList = null;
let cachedWhitelistKey = null;

// Loopback set for 'localhost' mode is static — build it once. 127.0.0.0/8
// covers all IPv4 loopback; ::1 is the IPv6 loopback. With the IPv4-mapped
// normalization below, a "::ffff:127.0.0.1" client resolves to 127.0.0.1
// and matches the IPv4 subnet here.
const loopbackBlockList = new BlockList();
loopbackBlockList.addSubnet('127.0.0.0', 8, 'ipv4');
loopbackBlockList.addAddress('::1', 'ipv6');

// Strip a leading "::ffff:" IPv4-mapped-IPv6 prefix so an IPv4 client that
// arrives over the dual-stack "::" bind (as "::ffff:192.168.1.5") is checked
// as plain IPv4. Returns { ip, type } where type is 'ipv4' | 'ipv6'. Only
// strips when the remainder is a dotted-quad — leaves real IPv6 untouched.
function normalizeIp(rawIp) {
  let ip = rawIp;
  // Match the prefix case-INsensitively: Node's own socket.remoteAddress is
  // lowercase, but with trust proxy the value comes verbatim from
  // X-Forwarded-For and can carry uppercase hex ('::FFFF:127.0.0.1'). Missing
  // that would leave a mapped address typed as ipv6 and wrongly block a
  // legitimate loopback/whitelisted client.
  if (/^::ffff:/i.test(ip)) {
    const rest = ip.slice('::ffff:'.length);
    // dotted-quad → it's an IPv4-mapped address; check as IPv4
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(rest)) {
      ip = rest;
    }
  }
  return { ip, type: ip.includes(':') ? 'ipv6' : 'ipv4' };
}

// Build a BlockList from a whitelist of IPs/CIDRs. Each entry is wrapped in
// try/catch so one malformed line (operator typo) is logged and skipped
// rather than crashing the gate — fail-soft, never take admin access down
// over a bad config string. ipv4 vs ipv6 is decided by presence of ':'.
function buildWhitelistBlockList(whitelist) {
  const blockList = new BlockList();
  // Entries should be authored as plain IPv4 ('192.168.0.0/16') or IPv6
  // ('fd00::/8'). An IPv4-mapped form ('::ffff:10.0.0.0/...') would be added as
  // ipv6 here and never match inbound clients, which normalizeIp strips to
  // plain IPv4 before checking. The shipped defaults are all plain v4/v6.
  for (const entry of whitelist) {
    try {
      const isV6 = entry.includes(':');
      const type = isV6 ? 'ipv6' : 'ipv4';
      const slash = entry.indexOf('/');
      if (slash !== -1) {
        const addr = entry.slice(0, slash);
        const prefix = Number(entry.slice(slash + 1));
        blockList.addSubnet(addr, prefix, type);
      } else {
        blockList.addAddress(entry, type);
      }
    } catch (err) {
      winston.warn(`[admin-network] ignoring malformed adminAccess.whitelist entry '${entry}': ${err.message}`);
    }
  }
  return blockList;
}

// Return (rebuilding if needed) the cached BlockList for the current
// whitelist. Keyed on the JSON-serialized array so an in-place edit to the
// whitelist rebuilds even if invalidate wasn't called.
function getWhitelistBlockList(whitelist) {
  const key = JSON.stringify(whitelist);
  if (cachedWhitelistBlockList === null || cachedWhitelistKey !== key) {
    cachedWhitelistBlockList = buildWhitelistBlockList(whitelist);
    cachedWhitelistKey = key;
  }
  return cachedWhitelistBlockList;
}

// Drop the cached whitelist BlockList so it rebuilds on the next request.
// Called by util/admin.editAdminAccess after the whitelist/mode changes.
export function invalidateWhitelistCache() {
  cachedWhitelistBlockList = null;
  cachedWhitelistKey = null;
}

// Decide whether `req` is allowed to reach the admin surface under the
// current mode. Uses req.ip (which already honors Express "trust proxy",
// configured in server.js). Logs the cause on every denial — project
// convention is to always log why a request was refused.
export function isAdminAllowed(req) {
  const adminAccess = config.program.adminAccess || {};
  const mode = adminAccess.mode || 'all';

  if (mode === 'all') { return true; }
  if (mode === 'none') {
    winston.warn(`[admin-network] denied admin access from ${req.ip || 'unknown'} to ${req.path} (mode=none)`);
    return false;
  }

  // localhost / whitelist both need a usable client IP.
  if (!req.ip) {
    winston.warn(`[admin-network] denied admin access: req.ip is undefined for ${req.path} (mode=${mode})`);
    return false;
  }

  const { ip, type } = normalizeIp(req.ip);

  let allowed;
  if (mode === 'localhost') {
    allowed = loopbackBlockList.check(ip, type);
  } else { // 'whitelist'
    allowed = getWhitelistBlockList(adminAccess.whitelist || []).check(ip, type);
  }

  if (!allowed) {
    // Log both the raw req.ip and the address actually checked — they differ
    // for IPv4-mapped clients, and the gap is confusing during the exact
    // whitelist-debugging this log exists for.
    winston.warn(`[admin-network] denied admin access from ${req.ip} (checked as ${ip}) to ${req.path} (mode=${mode})`);
  }
  return allowed;
}
