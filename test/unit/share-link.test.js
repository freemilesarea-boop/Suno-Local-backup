'use strict';

const { parseSunoUrl } = require('../../src/core/url');
const { SunoAdapter, extractCanonicalId } = require('../../src/core/suno-adapter');
const { getBuffered } = require('../../src/core/net');
const { startServer } = require('../helpers/fixtures');

const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('Suno share-link resolution', () => {
  test('T80 valid Suno share URL accepted by the parser', () => {
    const r = parseSunoUrl('https://suno.com/s/QNkchDHN6UChu6I3');
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('share');
    expect(r.shareCode).toBe('QNkchDHN6UChu6I3');
    expect(r.id).toBeNull();
  });

  test('T81 share URL resolves to canonical track via redirect final URL', async () => {
    const adapter = new SunoAdapter({
      fetchRaw: async () => ({
        statusCode: 200,
        finalUrl: `https://suno.com/song/${UUID}`,
        body: '<html></html>',
      }),
    });
    const parsed = parseSunoUrl('https://suno.com/s/QNkchDHN6UChu6I3');
    const r = await adapter.resolveShareLink(parsed);
    expect(r.ok).toBe(true);
    expect(r.id).toBe(UUID);
    expect(r.kind).toBe('song');
    expect(r.canonicalUrl).toBe(`https://suno.com/song/${UUID}`);
  });

  test('T82 malformed share code rejected by the parser', () => {
    expect(parseSunoUrl('https://suno.com/s/!!').ok).toBe(false);
    expect(parseSunoUrl('https://suno.com/s/ab').ok).toBe(false); // too short
    expect(parseSunoUrl('https://suno.com/s/').ok).toBe(false);
  });

  test('T83 unsafe redirect (to a disallowed host) is rejected before connecting', async () => {
    // Simulate the share endpoint redirecting off to a non-allowed host. The
    // net layer must refuse to follow it (this is what the real fetchRaw uses).
    const server = await startServer({
      '/s/code': (req, res) => {
        res.writeHead(302, { location: 'http://evil.example.com/steal' });
        res.end();
      },
    });
    try {
      await expect(
        getBuffered(server.url('/s/code'), {
          hostAllowed: (h) => h === '127.0.0.1', // only the test host is allowed
          allowPrivate: true,
          maxRedirects: 5,
        })
      ).rejects.toThrow(/host not in allowlist|not allowed/i);
    } finally {
      await server.close();
    }
  });

  test('T83b redirect to a private/loopback address is rejected', async () => {
    const server = await startServer({
      '/s/code': (req, res) => {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
        res.end();
      },
    });
    try {
      await expect(
        getBuffered(server.url('/s/code'), {
          hostAllowed: () => true, // even if "allowed", the private guard blocks it
          allowPrivate: false,
          maxRedirects: 5,
        })
      ).rejects.toThrow(/local\/private/i);
    } finally {
      await server.close();
    }
  });

  test('T84 redirect loop is bounded', async () => {
    const server = await startServer({
      '/loop': (req, res) => {
        res.writeHead(302, { location: '/loop' });
        res.end();
      },
    });
    try {
      await expect(
        getBuffered(server.url('/loop'), {
          hostAllowed: (h) => h === '127.0.0.1',
          allowPrivate: true,
          maxRedirects: 3,
        })
      ).rejects.toThrow(/too many redirects/i);
    } finally {
      await server.close();
    }
  });

  test('T85 canonical resolution preserves track id from page metadata', async () => {
    // Final URL is NOT canonical, but the page exposes a canonical <link>.
    const adapter = new SunoAdapter({
      fetchRaw: async () => ({
        statusCode: 200,
        finalUrl: 'https://suno.com/s/QNkchDHN6UChu6I3',
        body: `<html><head><link rel="canonical" href="https://suno.com/song/${UUID}"/></head></html>`,
      }),
    });
    const parsed = parseSunoUrl('https://suno.com/s/QNkchDHN6UChu6I3');
    const r = await adapter.resolveShareLink(parsed);
    expect(r.ok).toBe(true);
    expect(r.id).toBe(UUID);
  });

  test('T85b og:url and bare /song/<uuid> fallbacks also work', () => {
    expect(
      extractCanonicalId(null, `<meta property="og:url" content="https://suno.com/song/${UUID}">`)
    ).toBe(UUID);
    expect(extractCanonicalId(null, `junk https://suno.com/song/${UUID} more`)).toBe(UUID);
    expect(extractCanonicalId('https://suno.com/s/abcd', '<html>no id here</html>')).toBeNull();
  });

  test('resolveShareLink fails closed on 403 (auth) and 404 (missing)', async () => {
    const auth = new SunoAdapter({ fetchRaw: async () => ({ statusCode: 403 }) });
    const missing = new SunoAdapter({ fetchRaw: async () => ({ statusCode: 404 }) });
    const parsed = parseSunoUrl('https://suno.com/s/QNkchDHN6UChu6I3');
    const a = await auth.resolveShareLink(parsed);
    expect(a.ok).toBe(false);
    expect(a.authRequired).toBe(true);
    const m = await missing.resolveShareLink(parsed);
    expect(m.ok).toBe(false);
  });
});
