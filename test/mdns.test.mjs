/**
 * mDNS / DNS-SD advertiser tests — exercise the wire-format builders and query
 * parser in src/discovery/mdns.js directly, as pure functions. No socket is
 * bound (port 5353 is owned by the OS responder on most dev machines), so these
 * are fast and deterministic.
 *
 * Run: `npm run test:discovery` or `node --test test/mdns.test.mjs`
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeName,
  clampLabel,
  announce,
  buildAnnouncementPacket,
  parseQuestions,
  matchesOurNames,
} from '../src/discovery/mdns.js';

// A fixed service descriptor — mirrors what gatherInfo() produces, but without
// touching config so the builders stay isolated.
const info = {
  instanceName: 'Test Server',
  instanceId: 'abcd1234-0000-0000-0000-000000000000',
  targetHost: 'mstream-abcd1234',
  scheme: 'http',
  port: 3000,
  path: '/',
  version: '6.11.0',
  ips: ['192.168.1.50'],
  publicUrl: '',
};

const PTR = 12;
const IN = 1;

// Build a minimal mDNS query packet for one question.
function query(labels, type) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4); // QDCOUNT = 1
  const tc = Buffer.alloc(4);
  tc.writeUInt16BE(type, 0);
  tc.writeUInt16BE(IN, 2);
  return Buffer.concat([header, encodeName(labels), tc]);
}

describe('mdns wire format', () => {
  test('encodeName length-prefixes each label and root-terminates', () => {
    const got = encodeName(['_mstream', '_tcp', 'local']);
    const want = Buffer.concat([
      Buffer.from([8]), Buffer.from('_mstream'),
      Buffer.from([4]), Buffer.from('_tcp'),
      Buffer.from([5]), Buffer.from('local'),
      Buffer.from([0]),
    ]);
    assert.deepEqual(got, want);
  });

  test('announcement carries PTR, DNS-SD meta, SRV, TXT and an A record', () => {
    const pkt = buildAnnouncementPacket(info);

    // Response header: QR + AA set, 5 answers (PTR, _services PTR, SRV, TXT, 1×A)
    assert.equal(pkt.readUInt16BE(2), 0x8400);
    assert.equal(pkt.readUInt16BE(6), 5);

    // Service type name present
    assert.ok(pkt.includes(encodeName(['_mstream', '_tcp', 'local'])));
    // TXT key/values
    assert.ok(pkt.includes(Buffer.from(`id=${info.instanceId}`)));
    assert.ok(pkt.includes(Buffer.from(`v=${info.version}`)));
    assert.ok(pkt.includes(Buffer.from(`port=${info.port}`)));
    // SRV target host + port 3000 (0x0BB8)
    assert.ok(pkt.includes(Buffer.from('mstream-abcd1234')));
    assert.ok(pkt.includes(Buffer.from([0x0b, 0xb8])));
    // A record address
    assert.ok(pkt.includes(Buffer.from([192, 168, 1, 50])));
  });

  test('one A record is emitted per advertised address', () => {
    const multi = { ...info, ips: ['192.168.1.50', '10.0.0.9'] };
    const pkt = buildAnnouncementPacket(multi);
    assert.equal(pkt.readUInt16BE(6), 6); // 4 fixed answers + 2 A records
    assert.ok(pkt.includes(Buffer.from([10, 0, 0, 9])));
  });

  test('goodbye packet zeroes the TTL', () => {
    // First answer = service PTR: header(12) + name(21) + type(2) + class(2),
    // then the 4-byte TTL at offset 37.
    const alive = buildAnnouncementPacket(info);
    const bye = buildAnnouncementPacket(info, { goodbye: true });
    assert.equal(alive.readUInt32BE(37), 4500);
    assert.equal(bye.readUInt32BE(37), 0);
  });

  test('iroh=1 TXT entry is present only when irohEnabled', () => {
    // Off by default (descriptor without the flag): no iroh capability advertised.
    assert.ok(!buildAnnouncementPacket(info).includes(Buffer.from('iroh=1')));
    // Enabled: the capability flag is carried so a LAN client can pair for roaming.
    const withIroh = { ...info, irohEnabled: true };
    assert.ok(buildAnnouncementPacket(withIroh).includes(Buffer.from('iroh=1')));
  });
});

describe('mdns query handling', () => {
  test('parseQuestions reads name and type', () => {
    const questions = parseQuestions(query(['_mstream', '_tcp', 'local'], PTR));
    assert.equal(questions.length, 1);
    assert.equal(questions[0].name, '_mstream._tcp.local');
    assert.equal(questions[0].type, PTR);
  });

  test('parseQuestions follows a compression pointer', () => {
    // header(12) + question[pointer->18, type, class](6) + real name at 18
    const header = Buffer.alloc(12);
    header.writeUInt16BE(1, 4);
    const q = Buffer.from([0xc0, 18, 0x00, PTR, 0x00, IN]);
    const msg = Buffer.concat([header, q, encodeName(['_mstream', '_tcp', 'local'])]);
    const questions = parseQuestions(msg);
    assert.equal(questions[0].name, '_mstream._tcp.local');
    assert.equal(questions[0].type, PTR);
  });

  test('matchesOurNames is true for our service and instance, false otherwise', () => {
    assert.equal(matchesOurNames(parseQuestions(query(['_mstream', '_tcp', 'local'], PTR)), info), true);
    assert.equal(matchesOurNames(parseQuestions(query(['_services', '_dns-sd', '_udp', 'local'], PTR)), info), true);
    assert.equal(matchesOurNames(parseQuestions(query(['Test Server', '_mstream', '_tcp', 'local'], PTR)), info), true);
    assert.equal(matchesOurNames(parseQuestions(query(['_http', '_tcp', 'local'], PTR)), info), false);
  });

  test('parseQuestions tolerates a truncated/garbage packet', () => {
    assert.deepEqual(parseQuestions(Buffer.from([0, 0, 0])), []);
    assert.deepEqual(parseQuestions(Buffer.alloc(0)), []);
  });
});

// Regression: a `discovery.mdns.name` (or `os.hostname()`) longer than the
// 63-octet DNS label limit used to make encodeName() throw inside announce(),
// which runs in the bind callback and the announce timer — an uncaught throw
// there took the whole server down on boot. The instance name is now clamped.
describe('mdns label clamping (crash regression)', () => {
  test('clampLabel passes through names at or under 63 bytes unchanged', () => {
    assert.equal(clampLabel('My Server'), 'My Server');
    assert.equal(clampLabel('A'.repeat(63)), 'A'.repeat(63)); // exactly at the limit
    // Exactly 63 bytes but ending on a 2-byte char must still pass through verbatim
    // — guards against a too-greedy clamp or a `<` vs `<=` boundary mutation.
    const exact63 = 'A'.repeat(61) + 'é'; // 61 + 2 = 63 bytes
    assert.equal(Buffer.byteLength(exact63, 'utf8'), 63);
    assert.equal(clampLabel(exact63), exact63);
  });

  test('clampLabel truncates at the 64-byte boundary (the original off-by-one)', () => {
    assert.equal(Buffer.byteLength(clampLabel('A'.repeat(64)), 'utf8'), 63); // smallest over-limit
    assert.equal(Buffer.byteLength(clampLabel('A'.repeat(200)), 'utf8'), 63);
  });

  test('clampLabel is robust to non-string input (a guard must never throw)', () => {
    assert.equal(clampLabel(undefined), '');
    assert.equal(clampLabel(null), '');
    assert.doesNotThrow(() => clampLabel(12345));
    assert.doesNotThrow(() => clampLabel({}));
  });

  test('clampLabel never splits a multibyte UTF-8 character', () => {
    const twoByte = clampLabel('é'.repeat(40)); // 80 bytes of 2-byte code points
    assert.ok(Buffer.byteLength(twoByte, 'utf8') <= 63);
    assert.ok(!twoByte.includes('�'));      // no broken/replacement character
    assert.equal(clampLabel(twoByte), twoByte);  // re-clamping is a no-op

    const fourByte = clampLabel('😀'.repeat(30)); // 120 bytes of 4-byte code points
    assert.ok(Buffer.byteLength(fourByte, 'utf8') <= 63);
    assert.ok(!fourByte.includes('�'));
  });

  test('a clamped over-long name is always encodeName-safe (no throw)', () => {
    for (const raw of ['A'.repeat(200), 'é'.repeat(40), '😀'.repeat(30), 'Living Room '.repeat(20)]) {
      const label = clampLabel(raw);
      assert.ok(Buffer.byteLength(label, 'utf8') <= 63);
      assert.doesNotThrow(() => encodeName([label, '_mstream', '_tcp', 'local']));
    }
  });

  test('buildAnnouncementPacket does not throw for a clamped long instanceName', () => {
    const longInfo = { ...info, instanceName: clampLabel('Living Room Media Server '.repeat(5)) };
    assert.doesNotThrow(() => buildAnnouncementPacket(longInfo));
  });
});

// End-to-end: prove gatherInfo() actually applies the clamp from real config,
// so an operator-set name longer than 63 bytes can never reach encodeName().
describe('gatherInfo clamps a too-long configured name (end-to-end)', () => {
  test('a >63-byte discovery.mdns.name cannot crash the announce path', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const config = await import('../src/state/config.js');
    const { gatherInfo } = await import('../src/discovery/mdns.js');

    const cfgPath = path.join(os.tmpdir(), `mstream-mdns-clamp-${process.pid}.json`);
    await fs.writeFile(cfgPath, JSON.stringify({
      port: 3000,
      discovery: { mdns: { enabled: true, name: 'Living Room Media Server '.repeat(5) } },
    }));
    try {
      await config.setup(cfgPath);
      const i = gatherInfo();
      assert.ok(Buffer.byteLength(i.instanceName, 'utf8') <= 63);
      assert.doesNotThrow(() => buildAnnouncementPacket(i));
    } finally {
      await fs.unlink(cfgPath).catch(() => {});
    }
  });
});

// The safety net itself: announce() runs inside the bind callback and the
// re-announce timer, so a record-building throw there is uncaught and crashes
// the server. Prove announce() swallows-and-warns instead of throwing, even
// when given a malformed runtime config (the failure mode the try/catch guards).
describe('announce() never throws on a build failure (crash safety net)', () => {
  test('a gatherInfo/encode failure is caught and warned, not propagated', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const config = await import('../src/state/config.js');
    const winston = (await import('winston')).default;

    const cfgPath = path.join(os.tmpdir(), `mstream-mdns-announce-${process.pid}.json`);
    await fs.writeFile(cfgPath, JSON.stringify({ port: 3000, discovery: { mdns: { enabled: true } } }));
    await config.setup(cfgPath);

    const savedDiscovery = config.program.discovery;
    const origWarn = winston.warn;
    let warned = false;
    winston.warn = () => { warned = true; };
    try {
      // Corrupt config so gatherInfo() throws when announce() reads `.mdns`.
      // No socket is bound, so sendPacket() is a no-op — we isolate the catch.
      config.program.discovery = undefined;
      assert.doesNotThrow(() => announce());
      assert.ok(warned, 'announce() should winston.warn when a build fails');
    } finally {
      config.program.discovery = savedDiscovery;
      winston.warn = origWarn;
      await fs.unlink(cfgPath).catch(() => {});
    }
  });
});
