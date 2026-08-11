'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

/**
 * Resolve the bundled ffmpeg / ffprobe binary paths.
 *
 * We reuse the packaged binaries from ffmpeg-static / @ffprobe-installer. When the
 * app is packaged with Electron the binaries live inside an unpacked asar
 * directory; the `.asar` → `.asar.unpacked` rewrite handles that. No absolute
 * developer paths are ever hard-coded — everything derives from require.resolve.
 */

function unpacked(p) {
  // In a packaged Electron app, native binaries are extracted next to the asar.
  return p ? p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`) : p;
}

function resolveFfmpegPath() {
  try {
    // ffmpeg-static exports the binary path as its module value.
    // eslint-disable-next-line global-require
    const p = require('ffmpeg-static');
    return unpacked(p);
  } catch {
    return process.env.FFMPEG_PATH || null;
  }
}

function resolveFfprobePath() {
  try {
    // @ffprobe-installer/ffprobe selects a per-platform, per-arch NATIVE binary
    // via optional dependencies (e.g. @ffprobe-installer/darwin-arm64 on Apple
    // Silicon ships a real arm64 Mach-O — unlike ffprobe-static, whose darwin
    // "arm64" path held an x86_64 binary). `.path` is the resolved binary; the
    // asar→asar.unpacked rewrite handles the packaged layout.
    // eslint-disable-next-line global-require
    const p = require('@ffprobe-installer/ffprobe').path;
    return unpacked(p);
  } catch {
    return process.env.FFPROBE_PATH || null;
  }
}

/**
 * Run a binary with an argument ARRAY (never a shell string). This is the only
 * place external processes are spawned, and it is intentionally shell-free so
 * filenames with spaces or metacharacters cannot cause command injection.
 *
 * @param {string} bin
 * @param {string[]} args
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{stdout:string, stderr:string}>}
 */
function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    if (!bin) return reject(new Error('binary path not resolved'));
    if (!Array.isArray(args)) return reject(new Error('args must be an array'));
    execFile(
      bin,
      args,
      {
        timeout: opts.timeoutMs || 120000,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        signal: opts.signal,
      },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr;
          return reject(err);
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

function exists(p) {
  try {
    return !!p && fs.existsSync(p);
  } catch {
    return false;
  }
}

module.exports = { resolveFfmpegPath, resolveFfprobePath, run, exists };
