'use strict';

const fs = require('fs');
const path = require('path');
const { Logger, redact } = require('../../src/core/logger');
const { makeTempDir, rmrf } = require('../helpers/fixtures');

describe('Logger redaction', () => {
  let dir;
  beforeEach(() => (dir = makeTempDir()));
  afterEach(() => rmrf(dir));

  test('T42 logs redact credential-like values (object fields)', () => {
    const logPath = path.join(dir, 'x.log');
    const logger = new Logger({ filePath: logPath, console: false, now: () => 'T' });
    logger.info('event', {
      authorization: 'Bearer supersecrettoken',
      cookie: 'session=abc123',
      token: 'tok_live_123',
      password: 'hunter2',
      normal: 'visible-value',
    });
    const content = fs.readFileSync(logPath, 'utf8');
    expect(content).toContain('visible-value');
    expect(content).not.toContain('supersecrettoken');
    expect(content).not.toContain('abc123');
    expect(content).not.toContain('tok_live_123');
    expect(content).not.toContain('hunter2');
    expect(content).toContain('[REDACTED]');
  });

  test('T42b redacts signed-url query secrets but keeps base url', () => {
    const out = redact({
      msg: 'downloading https://cdn1.suno.ai/x.mp3?token=abc&Signature=zzz&plain=ok',
    });
    expect(out.msg).toContain('https://cdn1.suno.ai/x.mp3');
    expect(out.msg).not.toContain('abc');
    expect(out.msg).not.toContain('zzz');
    expect(out.msg).toContain('plain=ok');
  });

  test('T42c redacts inline Authorization/Bearer in free strings', () => {
    const out = redact('Authorization: Bearer abcdef123456 trailing');
    expect(out).not.toContain('abcdef123456');
    expect(out).toContain('[REDACTED]');
  });

  test('handles nested objects and arrays without throwing', () => {
    const out = redact({ a: { cookie: 'x' }, list: [{ token: 'y' }, 'plain'] });
    expect(out.a.cookie).toBe('[REDACTED]');
    expect(out.list[0].token).toBe('[REDACTED]');
    expect(out.list[1]).toBe('plain');
  });
});
