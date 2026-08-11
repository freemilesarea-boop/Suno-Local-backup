'use strict';

const fs = require('fs');
const { redactEvidence, isPrintableAscii } = require('./scan');

/**
 * Minimal, defensive container parsers for forensic enumeration only.
 *
 * These treat the file as HOSTILE input: every length is bounds-checked against
 * the actual bytes read, declared sizes are clamped, and no payload is ever
 * expanded/allocated based on an untrusted length. They read a bounded prefix
 * (ID3 lives at the very start; RIFF chunk headers are walked with clamping),
 * so memory stays bounded regardless of file size.
 */

const HEAD_BYTES = 512 * 1024; // enough for ID3v2 + RIFF header walk on real files

function readPrefix(filePath, max = HEAD_BYTES) {
  return new Promise((resolve, reject) => {
    fs.open(filePath, 'r', (err, fd) => {
      if (err) return reject(err);
      const buf = Buffer.alloc(max);
      fs.read(fd, buf, 0, max, 0, (e, n) => {
        fs.close(fd, () => {});
        if (e) return reject(e);
        resolve(buf.subarray(0, n));
      });
    });
  });
}

function statSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function textPreview(buf, max = 200) {
  let s = '';
  for (const b of buf) {
    if (b === 0) continue;
    s += isPrintableAscii(b) ? String.fromCharCode(b) : '';
    if (s.length >= max) break;
  }
  return redactEvidence(s.trim());
}

function hexPreviewOf(buf, max = 24) {
  return buf.subarray(0, max).toString('hex').replace(/(..)/g, '$1 ').trim();
}

/* --------------------------------- ID3 ---------------------------------- */

function synchsafe(buf, i) {
  return ((buf[i] & 0x7f) << 21) | ((buf[i + 1] & 0x7f) << 14) | ((buf[i + 2] & 0x7f) << 7) | (buf[i + 3] & 0x7f);
}

function parseId3(filePath, buf) {
  const result = { present: false, versions: [], frames: [] };
  const size = statSize(filePath);

  // ID3v1 lives in the last 128 bytes ("TAG"). Check it separately.
  if (size >= 128) {
    try {
      const fd = fs.openSync(filePath, 'r');
      const tail = Buffer.alloc(128);
      fs.readSync(fd, tail, 0, 128, size - 128);
      fs.closeSync(fd);
      if (tail.subarray(0, 3).toString('latin1') === 'TAG') {
        result.present = true;
        result.versions.push('ID3v1');
      }
    } catch {
      /* ignore */
    }
  }

  // ID3v2 at the start.
  if (buf.length >= 10 && buf.subarray(0, 3).toString('latin1') === 'ID3') {
    const major = buf[3];
    result.present = true;
    result.versions.push(`ID3v2.${major}`);
    const tagSize = synchsafe(buf, 6);
    const end = Math.min(buf.length, 10 + Math.max(0, tagSize));
    let i = 10;
    const idLen = major === 2 ? 3 : 4;
    const szLen = major === 2 ? 3 : 4;
    let guard = 0;
    while (i + idLen + szLen <= end && guard < 4096) {
      guard += 1;
      const id = buf.subarray(i, i + idLen).toString('latin1');
      if (!/^[A-Z0-9]{3,4}$/.test(id)) break; // padding / end of frames
      let frameSize;
      if (major === 2) {
        frameSize = (buf[i + 3] << 16) | (buf[i + 4] << 8) | buf[i + 5];
      } else if (major === 4) {
        frameSize = synchsafe(buf, i + 4);
      } else {
        frameSize = (buf[i + 4] << 24) | (buf[i + 5] << 16) | (buf[i + 6] << 8) | buf[i + 7];
      }
      const headerLen = idLen + szLen + (major === 2 ? 0 : 2);
      const dataStart = i + headerLen;
      // Clamp declared size to what we actually have — never trust it.
      const safeSize = Math.max(0, Math.min(frameSize, end - dataStart));
      const payload = buf.subarray(dataStart, dataStart + safeSize);
      const frame = {
        id,
        declaredSize: frameSize,
        size: safeSize,
        offset: i,
        hasBinary: false,
        preview: '',
        hexPreview: '',
      };
      // Text-ish frames start with an encoding byte; private/binary frames don't.
      if (/^T/.test(id) || id === 'COMM' || id === 'USLT' || id === 'WXXX' || /^W/.test(id)) {
        frame.preview = textPreview(payload);
      } else {
        frame.hasBinary = true;
        frame.preview = textPreview(payload, 80);
        frame.hexPreview = hexPreviewOf(payload);
      }
      result.frames.push(frame);
      if (safeSize === 0 && frameSize > 0) break; // corrupt/over-declared
      i = dataStart + safeSize;
    }
  }

  return result;
}

/* --------------------------------- RIFF --------------------------------- */

function parseInfoList(buf) {
  // A LIST payload begins with a 4CC type (e.g. "INFO"); then sub-chunks.
  const out = [];
  if (buf.length < 4) return out;
  const type = buf.subarray(0, 4).toString('latin1');
  let i = 4;
  let guard = 0;
  while (i + 8 <= buf.length && guard < 1024) {
    guard += 1;
    const id = buf.subarray(i, i + 4).toString('latin1');
    const sz = buf.readUInt32LE(i + 4);
    const dataStart = i + 8;
    const safe = Math.max(0, Math.min(sz, buf.length - dataStart));
    out.push({ list: type, id, size: safe, value: textPreview(buf.subarray(dataStart, dataStart + safe)) });
    i = dataStart + safe + (safe % 2); // word alignment
  }
  return out;
}

function parseBext(buf) {
  // Broadcast Wave bext chunk — fixed-ish layout; read defensively.
  const str = (a, b) => textPreview(buf.subarray(a, Math.min(b, buf.length)));
  return {
    description: str(0, 256),
    originator: str(256, 288),
    originatorReference: str(288, 320),
    originationDate: str(320, 330),
    originationTime: str(330, 338),
    codingHistoryPreview: buf.length > 602 ? str(602, Math.min(buf.length, 602 + 256)) : '',
  };
}

function parseRiff(buf) {
  const result = { isRiff: false, chunks: [], info: [], bext: null, ixmlPreview: null, hasId3Chunk: false, unknown: [] };
  if (buf.length < 12 || buf.subarray(0, 4).toString('latin1') !== 'RIFF') return result;
  result.isRiff = true;
  result.form = buf.subarray(8, 12).toString('latin1'); // "WAVE"
  const KNOWN = new Set(['fmt ', 'data', 'LIST', 'INFO', 'id3 ', 'ID3 ', 'bext', 'iXML', 'axml', 'JUNK', 'PAD ', 'cue ', 'smpl', 'fact']);
  let i = 12;
  let guard = 0;
  while (i + 8 <= buf.length && guard < 4096) {
    guard += 1;
    const fourcc = buf.subarray(i, i + 4).toString('latin1');
    const size = buf.readUInt32LE(i + 4);
    const dataStart = i + 8;
    const safe = Math.max(0, Math.min(size, buf.length - dataStart));
    const chunk = { fourCC: fourcc, offset: i, size, truncated: safe < size };
    result.chunks.push(chunk);
    const payload = buf.subarray(dataStart, dataStart + safe);
    if (fourcc === 'LIST') result.info.push(...parseInfoList(payload));
    else if (fourcc === 'bext') result.bext = parseBext(payload);
    else if (fourcc === 'iXML' || fourcc === 'axml') result.ixmlPreview = textPreview(payload, 400);
    else if (fourcc.toLowerCase() === 'id3 ') result.hasId3Chunk = true;
    else if (!KNOWN.has(fourcc)) result.unknown.push({ fourCC: fourcc, offset: i, size, preview: textPreview(payload, 60), hexPreview: hexPreviewOf(payload) });
    i = dataStart + safe + (safe % 2); // chunks are word-aligned
    if (safe === 0 && size > 0) break;
  }
  return result;
}

async function analyzeContainers(filePath, container) {
  const buf = await readPrefix(filePath);
  const out = { id3: null, riff: null };
  const c = String(container || '').toLowerCase();
  const looksMp3 = c.includes('mp3') || (buf.length >= 3 && buf.subarray(0, 3).toString('latin1') === 'ID3');
  const looksWav = c.includes('wav') || (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === 'RIFF');
  if (looksMp3) out.id3 = parseId3(filePath, buf);
  if (looksWav) out.riff = parseRiff(buf);
  return out;
}

module.exports = { analyzeContainers, parseId3, parseRiff, parseInfoList, parseBext, readPrefix };
