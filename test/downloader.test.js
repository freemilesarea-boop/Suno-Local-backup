'use strict';

const fs = require('fs');
const path = require('path');
const { Downloader } = require('../src/core/downloader');
const { makeTempDir, rmrf, startServer } = require('./helpers/fixtures');

const AUDIO_BYTES = Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00fake-mp3-body');

describe('Downloader', () => {
  let dir;
  let server;
  const openPolicy = { hostAllowed: () => true, allowPrivate: true };

  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(async () => {
    if (server) await server.close();
    server = null;
    rmrf(dir);
  });

  function newDownloader() {
    // Instant backoff so retry tests run fast.
    return new Downloader({ sleep: () => Promise.resolve() });
  }

  test('T16 successful download writes the file', async () => {
    server = await startServer({
      '/audio.mp3': (req, res) => {
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': AUDIO_BYTES.length });
        res.end(AUDIO_BYTES);
      },
    });
    const dest = path.join(dir, 'out.mp3');
    const r = await newDownloader().download({ url: server.url('/audio.mp3'), destPath: dest, ...openPolicy });
    expect(r.bytes).toBe(AUDIO_BYTES.length);
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(dest)).toEqual(AUDIO_BYTES);
  });

  test('T17 uses a temporary .part and finalizes atomically', async () => {
    server = await startServer({
      '/a.mp3': (req, res) => {
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        res.end(AUDIO_BYTES);
      },
    });
    const dest = path.join(dir, 'song.mp3');
    await newDownloader().download({ url: server.url('/a.mp3'), destPath: dest, ...openPolicy });
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.existsSync(dest + '.part')).toBe(false); // staged part was renamed away
  });

  test('T18 incomplete download (interrupted) not finalized', async () => {
    server = await startServer({
      '/short.mp3': (req, res) => {
        // Promise a large body, send a little, then drop the connection.
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': 999999 });
        res.write(AUDIO_BYTES);
        req.socket.destroy();
      },
    });
    const dest = path.join(dir, 'short.mp3');
    await expect(
      newDownloader().download({ url: server.url('/short.mp3'), destPath: dest, maxRetries: 0, ...openPolicy })
    ).rejects.toThrow();
    // The incomplete data must not survive as a finished file.
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(dest + '.part')).toBe(false);
  });

  test('T18c 403 (signed-URL required) fails fast as HTTP_FORBIDDEN, no retry', async () => {
    let hits = 0;
    server = await startServer({
      '/locked.mp3': (req, res) => {
        hits += 1;
        res.writeHead(403, { 'content-type': 'text/xml' });
        res.end('<?xml version="1.0"?><Error><Code>AccessDenied</Code></Error>');
      },
    });
    const dest = path.join(dir, 'locked.mp3');
    await expect(
      newDownloader().download({ url: server.url('/locked.mp3'), destPath: dest, ...openPolicy })
    ).rejects.toMatchObject({ code: 'HTTP_FORBIDDEN' });
    expect(hits).toBe(1); // not retried — a signed URL won't appear on retry
    expect(fs.existsSync(dest)).toBe(false);
  });

  test('T19 zero-byte download rejected', async () => {
    server = await startServer({
      '/empty.mp3': (req, res) => {
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        res.end();
      },
    });
    const dest = path.join(dir, 'empty.mp3');
    await expect(
      newDownloader().download({ url: server.url('/empty.mp3'), destPath: dest, ...openPolicy })
    ).rejects.toThrow(/zero-byte/);
    expect(fs.existsSync(dest)).toBe(false);
  });

  test('T20 HTML/error response not accepted as audio', async () => {
    server = await startServer({
      '/page': (req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!DOCTYPE html><html><body>Sign in</body></html>');
      },
    });
    const dest = path.join(dir, 'x.mp3');
    await expect(
      newDownloader().download({ url: server.url('/page'), destPath: dest, ...openPolicy })
    ).rejects.toThrow(/not audio/);
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(dest + '.part')).toBe(false);
  });

  test('T21 timeout handled', async () => {
    server = await startServer({
      '/hang': () => {
        /* never respond */
      },
    });
    const dest = path.join(dir, 'hang.mp3');
    await expect(
      newDownloader().download({
        url: server.url('/hang'),
        destPath: dest,
        timeoutMs: 200,
        maxRetries: 0,
        ...openPolicy,
      })
    ).rejects.toThrow(/timed out/);
  });

  test('T22 retries are bounded', async () => {
    let hits = 0;
    server = await startServer({
      '/flaky': (req, res) => {
        hits += 1;
        res.writeHead(503);
        res.end('unavailable');
      },
    });
    const dest = path.join(dir, 'flaky.mp3');
    await expect(
      newDownloader().download({ url: server.url('/flaky'), destPath: dest, maxRetries: 2, ...openPolicy })
    ).rejects.toThrow();
    expect(hits).toBe(3); // initial + 2 retries, then gives up
  });

  test('T23 temp file cleaned up after failure', async () => {
    server = await startServer({
      '/page': (req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html>nope</html>');
      },
    });
    const dest = path.join(dir, 'y.mp3');
    await expect(
      newDownloader().download({ url: server.url('/page'), destPath: dest, ...openPolicy })
    ).rejects.toThrow();
    expect(fs.existsSync(dest + '.part')).toBe(false);
  });

  test('follows a redirect to another allowed host', async () => {
    server = await startServer({
      '/redir': (req, res) => {
        res.writeHead(302, { location: '/final.mp3' });
        res.end();
      },
      '/final.mp3': (req, res) => {
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        res.end(AUDIO_BYTES);
      },
    });
    const dest = path.join(dir, 'r.mp3');
    const r = await newDownloader().download({ url: server.url('/redir'), destPath: dest, ...openPolicy });
    expect(r.bytes).toBe(AUDIO_BYTES.length);
  });
});
