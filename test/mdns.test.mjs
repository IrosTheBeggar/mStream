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
