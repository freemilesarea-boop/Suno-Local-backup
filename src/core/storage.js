'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

/**
 * Storage Manager — generic filesystem placement with safety rails.
 *
 *  - Filenames derived from external metadata are aggressively sanitized.
 *  - Path traversal is impossible: the final path is verified to stay within
 *    the chosen destination directory.
 *  - Collisions are resolved by suffixing, never by silently overwriting an
 *    existing file (no data loss).
 */

const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

const MAX_BASENAME = 120; // conservative, leaves room for suffixes + extension

/**
 * Sanitize a title into a filesystem-safe base name (no extension).
 * Safe on both Windows and macOS/Linux.
 * @param {string} title
 * @param {object} [opts]
 * @param {string} [opts.fallback]
 * @param {number} [opts.maxLength]
 * @returns {string}
 */
function sanitizeFilename(title, opts = {}) {
  const fallback = opts.fallback || 'untitled';
  const maxLength = opts.maxLength || MAX_BASENAME;

  let name = typeof title === 'string' ? title : '';
  // Normalize unicode so combining marks don't explode length unexpectedly.
  try {
    name = name.normalize('NFC');
  } catch {
    /* ignore */
  }
  // Strip path separators and Windows-illegal characters.
  name = name.replace(/[\\/:*?"<>|]/g, ' ');
  // Strip ASCII control characters without embedding literal control bytes here.
  name = Array.from(name)
    .filter((ch) => {
      const c = ch.codePointAt(0);
      return c >= 0x20 && c !== 0x7f;
    })
    .join('');
  // Collapse whitespace.
  name = name.replace(/\s+/g, ' ').trim();
  // Remove trailing dots/spaces (illegal/awkward on Windows).
  name = name.replace(/[ .]+$/g, '').replace(/^[ .]+/g, '');
  // Truncate (by code points) to a safe length.
  if (Array.from(name).length > maxLength) {
    name = Array.from(name).slice(0, maxLength).join('').trim().replace(/[ .]+$/g, '');
  }
  if (!name) name = fallback;
  // Reserved device names (case-insensitive, ignoring extension).
  if (WINDOWS_RESERVED.has(name.toUpperCase())) {
    name = `_${name}`;
  }
  return name;
}

/**
 * Build a safe base name for a track, optionally disambiguated by a short id.
 * @param {{title?:string, id?:string}} track
 * @param {object} [opts] {includeId:boolean}
 */
function trackBaseName(track, opts = {}) {
  const base = sanitizeFilename(track.title || '', { fallback: track.id ? `suno_${short(track.id)}` : 'untitled' });
  if (opts.includeId && track.id) {
    return `${base}_${short(track.id)}`;
  }
  return base;
}

function short(id) {
  return String(id || '').replace(/-/g, '').slice(0, 8) || 'unknown';
}

/**
 * Resolve a child path and guarantee it stays inside `baseDir`.
 * Throws on traversal attempts.
 */
function safeJoin(baseDir, ...parts) {
  const resolvedBase = path.resolve(baseDir);
  const joined = path.resolve(resolvedBase, ...parts);
  const rel = path.relative(resolvedBase, joined);
  if (rel === '' || rel === '.') {
    // joined === base is not a file target
    throw new Error('resolved path equals base directory');
  }
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path traversal blocked: ${rel}`);
  }
  return joined;
}

class StorageManager {
  /**
   * @param {object} opts
   * @param {string} opts.baseDir - user-selected output directory
   */
  constructor(opts = {}) {
    if (!opts.baseDir) throw new Error('StorageManager requires baseDir');
    this.baseDir = path.resolve(opts.baseDir);
  }

  async ensureBase() {
    await fsp.mkdir(this.baseDir, { recursive: true });
    return this.baseDir;
  }

  /**
   * Allocate a non-colliding absolute path for `<baseName>.<ext>` inside an
   * optional subdirectory. Never returns a path to an existing file.
   * @param {string} baseName - already sanitized
   * @param {string} ext - without dot
   * @param {object} [opts] {subDir}
   * @returns {Promise<string>}
   */
  async allocatePath(baseName, ext, opts = {}) {
    const cleanBase = sanitizeFilename(baseName, {});
    const cleanExt = String(ext || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase() || 'bin';
    const dir = opts.subDir ? safeJoin(this.baseDir, opts.subDir) : this.baseDir;
    await fsp.mkdir(dir, { recursive: true });

    let candidate = this._within(dir, `${cleanBase}.${cleanExt}`);
    let n = 1;
    while (await pathExists(candidate)) {
      candidate = this._within(dir, `${cleanBase} (${n}).${cleanExt}`);
      n += 1;
      if (n > 9999) throw new Error('too many filename collisions');
    }
    return candidate;
  }

  _within(dir, filename) {
    const resolvedBase = this.baseDir;
    const joined = path.resolve(dir, filename);
    const rel = path.relative(resolvedBase, joined);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`path traversal blocked: ${rel}`);
    }
    return joined;
  }

  /** Atomically move a finished temp file into place. */
  async place(tempPath, finalPath) {
    await fsp.mkdir(path.dirname(finalPath), { recursive: true });
    await fsp.rename(tempPath, finalPath);
    return finalPath;
  }
}

async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  sanitizeFilename,
  trackBaseName,
  safeJoin,
  StorageManager,
  short,
  WINDOWS_RESERVED,
  MAX_BASENAME,
};
