'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const http = require('http');

const ffmpegPath = require('ffmpeg-static');

const FIX_DIR = path.join(__dirname, '..', '.tmp', 'fixtures');

/** Create a unique temp working directory for a test. */
function makeTempDir(prefix = 'suno-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Generate (once) shared audio fixtures using the bundled ffmpeg. */
function ensureAudioFixtures() {
  fs.mkdirSync(FIX_DIR, { recursive: true });
  const wav = path.join(FIX_DIR, 'tone.wav');
  const mp3 = path.join(FIX_DIR, 'tone.mp3');
  const corrupt = path.join(FIX_DIR, 'corrupt.mp3');

  if (!fs.existsSync(wav)) {
    execFileSync(ffmpegPath, [
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-ar', '44100', '-ac', '2', '-y', wav,
    ]);
  }
  if (!fs.existsSync(mp3)) {
    execFileSync(ffmpegPath, [
      '-i', wav, '-c:a', 'libmp3lame', '-q:a', '5', '-y', mp3,
    ]);
  }
  if (!fs.existsSync(corrupt)) {
    fs.writeFileSync(corrupt, Buffer.from('this is not audio, just text bytes'.repeat(4)));
  }
  return { wav, mp3, corrupt };
}

/**
 * Start a local HTTP server that serves canned responses. Returns
 * { url(path), close() }. Handlers is a map of pathname -> handler(req,res).
 */
function startServer(handlers) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const handler = handlers[u.pathname] || handlers['*'];
    if (!handler) {
      res.statusCode = 404;
      return res.end('not found');
    }
    handler(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        origin: `http://127.0.0.1:${port}`,
        url: (p) => `http://127.0.0.1:${port}${p}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

module.exports = { makeTempDir, ensureAudioFixtures, startServer, rmrf, FIX_DIR, ffmpegPath };
