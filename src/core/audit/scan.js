'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { redactString } = require('../logger');

/**
 * Low-level, read-only, bounded-memory file scanning primitives.
 *
 * Nothing here opens a file for writing. Everything streams in fixed-size
 * chunks so multi-hundred-MB files never land in RAM whole.
 */

const CHUNK = 64 * 1024;

/** Streaming SHA-256 (+ size). Never buffers the whole file. */
function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    let size = 0;
    const rs = fs.createReadStream(filePath, { highWaterMark: CHUNK });
    rs.on('data', (c) => {
      size += c.length;
      h.update(c);
    });
    rs.on('error', reject);
    rs.on('end', () => resolve({ sha256: h.digest('hex'), size }));
  });
}

/** Redact URL query secrets / credential-like tokens from evidence text. */
function redactEvidence(text) {
  try {
    return redactString(String(text));
  } catch {
    return String(text);
  }
}

function isPrintableAscii(b) {
  return b >= 0x20 && b <= 0x7e;
}

/**
 * Find printable strings (ASCII, UTF-16LE, UTF-16BE) in a buffer, emitting
 * absolute offsets. Runs are length-capped; total hits are capped by the
 * caller via a shared `seen`/`hits` budget.
 */
function scanBuffer(buf, baseOffset, opts, hits, seen) {
  const min = opts.minLen;
  const maxLen = opts.maxMatch;
  const maxHits = opts.maxHits;

  const push = (offset, encoding, text) => {
    if (hits.length >= maxHits) return false;
    const key = `${encoding}:${offset}`;
    if (seen.has(key)) return true;
    seen.add(key);
    hits.push({ offset, encoding, text: redactEvidence(text).slice(0, maxLen) });
    return true;
  };

  // ASCII / UTF-8 (single-byte visible) runs.
  const latin = buf.toString('latin1');
  const re = new RegExp(`[\\x20-\\x7e]{${min},}`, 'g');
  let m;
  while ((m = re.exec(latin)) !== null) {
    if (!push(baseOffset + m.index, 'ascii', m[0])) return;
  }

  // UTF-16LE: printable byte followed by 0x00 (any alignment).
  for (let i = 0; i + 1 < buf.length; ) {
    if (isPrintableAscii(buf[i]) && buf[i + 1] === 0x00) {
      let j = i;
      let chars = '';
      while (j + 1 < buf.length && isPrintableAscii(buf[j]) && buf[j + 1] === 0x00 && chars.length < maxLen) {
        chars += String.fromCharCode(buf[j]);
        j += 2;
      }
      if (chars.length >= min) {
        if (hits.length >= maxHits) return;
        push(baseOffset + i, 'utf16le', chars);
      }
      i = j;
    } else i += 1;
  }

  // UTF-16BE: 0x00 followed by printable byte.
  for (let i = 0; i + 1 < buf.length; ) {
    if (buf[i] === 0x00 && isPrintableAscii(buf[i + 1])) {
      let j = i;
      let chars = '';
      while (j + 1 < buf.length && buf[j] === 0x00 && isPrintableAscii(buf[j + 1]) && chars.length < maxLen) {
        chars += String.fromCharCode(buf[j + 1]);
        j += 2;
      }
      if (chars.length >= min) {
        if (hits.length >= maxHits) return;
        push(baseOffset + i, 'utf16be', chars);
      }
      i = j;
    } else i += 1;
  }
}

/**
 * Scan a whole file for printable strings, bounded in memory and hit count.
 * @returns {Promise<Array<{offset:number, encoding:string, text:string}>>}
 */
function scanStrings(filePath, opts = {}) {
  const cfg = {
    minLen: opts.minLen || 4,
    maxMatch: opts.maxMatch || 256,
    maxHits: opts.maxHits || 500,
  };
  const keep = cfg.maxMatch * 2 + 8; // overlap so runs can cross a chunk boundary
  return new Promise((resolve, reject) => {
    const hits = [];
    const seen = new Set();
    let prevTail = Buffer.alloc(0);
    let prevTailOffset = 0;
    let pos = 0;
    const rs = fs.createReadStream(filePath, { highWaterMark: CHUNK });
    rs.on('data', (chunk) => {
      const buf = prevTail.length ? Buffer.concat([prevTail, chunk]) : chunk;
      const base = prevTail.length ? prevTailOffset : pos;
      scanBuffer(buf, base, cfg, hits, seen);
      // Keep a tail for boundary-spanning strings.
      if (buf.length > keep) {
        prevTail = Buffer.from(buf.subarray(buf.length - keep));
        prevTailOffset = base + buf.length - keep;
      } else {
        prevTail = Buffer.from(buf);
        prevTailOffset = base;
      }
      pos += chunk.length;
      if (hits.length >= cfg.maxHits) rs.destroy();
    });
    rs.on('error', reject);
    rs.on('close', () => resolve(hits));
    rs.on('end', () => resolve(hits));
  });
}

/**
 * Read a bounded window around an offset and return a hex + ASCII preview.
 * @returns {Promise<{startOffset:number, hex:string, ascii:string}>}
 */
function hexPreview(filePath, centerOffset, opts = {}) {
  const pre = opts.pre != null ? opts.pre : 8;
  const total = opts.bytes || 48;
  const start = Math.max(0, centerOffset - pre);
  return new Promise((resolve, reject) => {
    fs.open(filePath, 'r', (err, fd) => {
      if (err) return reject(err);
      const buf = Buffer.alloc(total);
      fs.read(fd, buf, 0, total, start, (e, bytesRead) => {
        fs.close(fd, () => {});
        if (e) return reject(e);
        const b = buf.subarray(0, bytesRead);
        const hex = b.toString('hex').replace(/(..)/g, '$1 ').trim();
        let ascii = '';
        for (const byte of b) ascii += isPrintableAscii(byte) ? String.fromCharCode(byte) : '.';
        resolve({ startOffset: start, hex, ascii: redactEvidence(ascii) });
      });
    });
  });
}

module.exports = { hashFile, scanStrings, hexPreview, redactEvidence, isPrintableAscii, CHUNK };
