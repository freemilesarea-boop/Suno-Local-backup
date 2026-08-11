'use strict';

const { parseSunoUrl, parseUrlList } = require('../../src/core/url');

const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('URL parsing / normalization', () => {
  test('T01 valid Suno URL accepted', () => {
    const r = parseSunoUrl(`https://suno.com/song/${UUID}`);
    expect(r.ok).toBe(true);
    expect(r.id).toBe(UUID);
    expect(r.canonicalUrl).toBe(`https://suno.com/song/${UUID}`);
  });

  test('T01b accepts app.suno.ai and normalizes to canonical', () => {
    const r = parseSunoUrl(`https://app.suno.ai/song/${UUID}?foo=bar`);
    expect(r.ok).toBe(true);
    expect(r.id).toBe(UUID);
    expect(r.canonicalUrl).toBe(`https://suno.com/song/${UUID}`);
  });

  test('T01c scheme-less input is accepted', () => {
    const r = parseSunoUrl(`suno.com/song/${UUID}`);
    expect(r.ok).toBe(true);
    expect(r.id).toBe(UUID);
  });

  test('T02 invalid domain rejected', () => {
    const r = parseSunoUrl(`https://evil.example.com/song/${UUID}`);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/host not allowed/);
  });

  test('T02b lookalike domain rejected', () => {
    const r = parseSunoUrl(`https://suno.com.evil.com/song/${UUID}`);
    expect(r.ok).toBe(false);
  });

  test('T03 malformed URL rejected', () => {
    expect(parseSunoUrl('not a url at all').ok).toBe(false);
    expect(parseSunoUrl('http://').ok).toBe(false);
    expect(parseSunoUrl('').ok).toBe(false);
  });

  test('T03b non-song path rejected', () => {
    expect(parseSunoUrl('https://suno.com/explore').ok).toBe(false);
  });

  test('T03c non-uuid song id rejected', () => {
    expect(parseSunoUrl('https://suno.com/song/12345').ok).toBe(false);
  });

  test('T04 whitespace normalized (trim) and internal whitespace rejected', () => {
    const r = parseSunoUrl(`   https://suno.com/song/${UUID}   `);
    expect(r.ok).toBe(true);
    expect(r.id).toBe(UUID);
    const bad = parseSunoUrl(`https://suno.com/song/${UUID.slice(0, 8)} ${UUID.slice(9)}`);
    expect(bad.ok).toBe(false);
  });

  test('T05 duplicate URLs deduplicated across variants', () => {
    const text = [
      `https://suno.com/song/${UUID}`,
      `https://app.suno.ai/song/${UUID}?x=1`, // same id, different host/query
      `   https://suno.com/song/${UUID}   `, // whitespace variant
      '',
      'garbage-line',
      `https://suno.com/song/ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee`,
    ].join('\n');
    const { valid, invalid } = parseUrlList(text);
    expect(valid.length).toBe(2); // two distinct ids
    expect(invalid.length).toBe(1); // the garbage line
  });

  test('rejects file:// and other protocols', () => {
    expect(parseSunoUrl('file:///etc/passwd').ok).toBe(false);
    expect(parseSunoUrl(`ftp://suno.com/song/${UUID}`).ok).toBe(false);
  });
});
