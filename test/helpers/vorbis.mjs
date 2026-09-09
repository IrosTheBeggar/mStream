/**
 * FLAC Vorbis-comment surgery for fixture generation (V72).
 *
 * ffmpeg's `-metadata KEY=value` keeps one value per key, so a genuinely
 * multi-valued Vorbis tag (two ARTIST comments) cannot be written from the
 * command line. This appends comments to the VORBIS_COMMENT block of a
 * FLAC ffmpeg already wrote: the block's 24-bit length is rewritten, every
 * other block and the audio frames are copied verbatim.
 */

import fs from 'node:fs/promises';

export async function appendFlacVorbisComments(filepath, pairs) {
  const buf = await fs.readFile(filepath);
  if (buf.toString('latin1', 0, 4) !== 'fLaC') { throw new Error(`${filepath}: not a FLAC stream`); }
  const out = [buf.subarray(0, 4)];
  let pos = 4;
  let patched = false;
  for (;;) {
    if (pos + 4 > buf.length) { throw new Error('FLAC metadata overruns the file'); }
    const header = buf[pos];
    const isLast = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const len = buf.readUIntBE(pos + 1, 3);
    const body = buf.subarray(pos + 4, pos + 4 + len);
    if (type === 4 && !patched) {                     // VORBIS_COMMENT
      const vendorLen = body.readUInt32LE(0);
      const countAt = 4 + vendorLen;
      const count = body.readUInt32LE(countAt);
      const entries = body.subarray(countAt + 4, len);
      const added = pairs.map(([k, v]) => {
        const s = Buffer.from(`${k}=${v}`, 'utf8');
        const l = Buffer.alloc(4); l.writeUInt32LE(s.length, 0);
        return Buffer.concat([l, s]);
      });
      const newCount = Buffer.alloc(4); newCount.writeUInt32LE(count + pairs.length, 0);
      const newBody = Buffer.concat([body.subarray(0, countAt), newCount, entries, ...added]);
      const newHeader = Buffer.alloc(4);
      newHeader[0] = header;
      newHeader.writeUIntBE(newBody.length, 1, 3);
      out.push(newHeader, newBody);
      patched = true;
    } else {
      out.push(buf.subarray(pos, pos + 4 + len));
    }
    pos += 4 + len;
    if (isLast) { break; }
  }
  if (!patched) { throw new Error(`${filepath}: no VORBIS_COMMENT block`); }
  out.push(buf.subarray(pos));
  await fs.writeFile(filepath, Buffer.concat(out));
}
