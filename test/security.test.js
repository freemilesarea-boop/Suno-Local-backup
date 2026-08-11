'use strict';

const path = require('path');
const { Downloader } = require('../src/core/downloader');
const { safeJoin, sanitizeFilename } = require('../src/core/storage');
const { validateStartPayload } = require('../src/main/validate');
const { run } = require('../src/core/ffmpeg');
const { isLocalOrPrivateHost } = require('../src/core/net');
const { makeTempDir, rmrf } = require('./helpers/fixtures');

describe('Security: network / SSRF', () => {
  const d = new Downloader({ sleep: () => Promise.resolve() });
  let dir;
  beforeEach(() => (dir = makeTempDir()));
  afterEach(() => rmrf(dir));

  test('T37 unsupported (non-Suno) host rejected under production policy', async () => {
    // expectedHost is a Suno CDN host; a mismatched host must be refused before
    // any request goes out.
    await expect(
      d.download({
        url: 'https://evil.example.com/track.mp3',
        expectedHost: 'cdn1.suno.ai',
        destPath: path.join(dir, 'x.mp3'),
      })
    ).rejects.toThrow(/host not allowed/);
  });

  test('T38 file:// scheme rejected', async () => {
    await expect(
      d.download({
        url: 'file:///etc/passwd',
        expectedHost: 'cdn1.suno.ai',
        destPath: path.join(dir, 'x.mp3'),
      })
    ).rejects.toThrow(/protocol not allowed/);
  });

  test('T39 localhost / private address rejected (private-host guard)', async () => {
    // Even if the host were "allowed", the private-IP guard blocks it.
    await expect(
      d.download({
        url: 'http://127.0.0.1:1/x.mp3',
        hostAllowed: () => true,
        allowPrivate: false,
        destPath: path.join(dir, 'x.mp3'),
      })
    ).rejects.toThrow(/local\/private/);
  });

  test('T39b private-range detector covers common ranges', () => {
    for (const h of ['localhost', '127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.1.1', '::1']) {
      expect(isLocalOrPrivateHost(h)).toBe(true);
    }
    for (const h of ['cdn1.suno.ai', '8.8.8.8', '1.1.1.1']) {
      expect(isLocalOrPrivateHost(h)).toBe(false);
    }
  });
});

describe('Security: filesystem', () => {
  test('T40 path traversal payload rejected', () => {
    const base = '/tmp/base';
    expect(() => safeJoin(base, '../../etc/passwd')).toThrow(/traversal/);
    expect(() => safeJoin(base, '..')).toThrow();
  });

  test('T40b traversal characters stripped from filenames', () => {
    const s = sanitizeFilename('../../etc/passwd');
    expect(s).not.toContain('/');
    expect(s).not.toContain('..');
  });
});

describe('Security: IPC input validation (no arbitrary command execution)', () => {
  const existing = () => true;

  test('T41 unknown format rejected (no passthrough of arbitrary options)', () => {
    expect(validateStartPayload({ text: 'x', format: 'rm -rf /', destDir: '/tmp' }, existing).ok).toBe(false);
    expect(validateStartPayload({ text: 'x', format: '../../evil', destDir: '/tmp' }, existing).ok).toBe(false);
  });

  test('T41 missing / malformed payloads rejected', () => {
    expect(validateStartPayload(null, existing).ok).toBe(false);
    expect(validateStartPayload({}, existing).ok).toBe(false);
    expect(validateStartPayload({ text: '', format: 'mp3', destDir: '/tmp' }, existing).ok).toBe(false);
    expect(validateStartPayload({ text: 'x', format: 'mp3', destDir: '' }, existing).ok).toBe(false);
    expect(validateStartPayload({ text: 'x', format: 'mp3', destDir: '/nope' }, () => false).ok).toBe(false);
  });

  test('T41 valid payload accepted', () => {
    const r = validateStartPayload({ text: 'https://suno.com/song/x', format: 'mp3', destDir: '/tmp' }, existing);
    expect(r.ok).toBe(true);
  });

  test('T41c ffmpeg run rejects a non-array (shell-string) argument', async () => {
    await expect(run('/bin/echo', 'hi; touch pwned')).rejects.toThrow(/array/);
  });
});
