'use strict';

const { SunoAdapter, parseClipMetadata, isSunoHost, extractPageAudioUrl } = require('../../src/core/suno-adapter');

const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const parsed = { id: UUID, canonicalUrl: `https://suno.com/song/${UUID}`, kind: 'song', ok: true };

describe('Suno metadata parsing', () => {
  test('T09 metadata parser success', () => {
    const raw = {
      id: UUID,
      title: 'My Song',
      audio_url: `https://cdn1.suno.ai/${UUID}.mp3`,
      image_url: `https://cdn1.suno.ai/image_${UUID}.png`,
      created_at: '2024-01-02T03:04:05Z',
      is_public: true,
      metadata: { duration: 123.4 },
    };
    const md = parseClipMetadata(raw, { id: UUID, canonicalUrl: parsed.canonicalUrl });
    expect(md.id).toBe(UUID);
    expect(md.title).toBe('My Song');
    expect(md.audioUrl).toContain('.mp3');
    expect(md.duration).toBeCloseTo(123.4);
    expect(md.isPublic).toBe(true);
    expect(md.imageUrl).toContain('image_');
  });

  test('T10 missing optional metadata handled', () => {
    const md = parseClipMetadata({ id: UUID }, { canonicalUrl: parsed.canonicalUrl });
    expect(md.id).toBe(UUID);
    expect(md.url).toBe(parsed.canonicalUrl);
    expect(md.title).toBeUndefined();
    expect(md.audioUrl).toBeUndefined();
    expect(md.duration).toBeUndefined();
  });

  test('T11 malformed metadata fails safely', () => {
    expect(() => parseClipMetadata(null)).toThrow();
    expect(() => parseClipMetadata('a string')).toThrow();
    expect(() => parseClipMetadata({})).toThrow(/clip id/);
  });

  test('does not fabricate a duration from garbage', () => {
    const md = parseClipMetadata({ id: UUID, duration: 'not-a-number' });
    expect(md.duration).toBeUndefined();
  });

  test('isSunoHost only accepts Suno-owned hosts', () => {
    expect(isSunoHost('cdn1.suno.ai')).toBe(true);
    expect(isSunoHost('suno.com')).toBe(true);
    expect(isSunoHost('studio-api.suno.ai')).toBe(true);
    expect(isSunoHost('evil.com')).toBe(false);
    expect(isSunoHost('suno.ai.evil.com')).toBe(false);
  });
});

describe('SunoAdapter.fetchMetadata (injected fetch)', () => {
  test('maps 200 + json to ok', async () => {
    const adapter = new SunoAdapter({
      fetchJson: async () => ({ statusCode: 200, json: { id: UUID, title: 'X', audio_url: `https://cdn1.suno.ai/${UUID}.mp3` } }),
    });
    const res = await adapter.fetchMetadata(parsed);
    expect(res.status).toBe('ok');
    expect(res.metadata.title).toBe('X');
  });

  test('maps 401/403 to auth_required', async () => {
    const adapter = new SunoAdapter({ fetchJson: async () => ({ statusCode: 403 }) });
    const res = await adapter.fetchMetadata(parsed);
    expect(res.status).toBe('auth_required');
  });

  test('maps 404 to not_found', async () => {
    const adapter = new SunoAdapter({ fetchJson: async () => ({ statusCode: 404 }) });
    const res = await adapter.fetchMetadata(parsed);
    expect(res.status).toBe('not_found');
  });

  test('network failure on all endpoints reported as error', async () => {
    const adapter = new SunoAdapter({
      fetchJson: async () => {
        const e = new Error('boom');
        e.code = 'TIMEOUT';
        throw e;
      },
    });
    const res = await adapter.fetchMetadata(parsed);
    expect(res.status).toBe('error');
  });
});

describe('Public-page metadata fallback (clip API 503)', () => {
  const pageBody = `<!DOCTYPE html><html><head>
    <title>My Great Track | Suno</title>
    <meta property="og:title" content="My Great Track"/>
    <meta property="og:image" content="https://cdn2.suno.ai/image_${UUID}.jpeg"/>
    </head><body>
    <audio src="https://cdn1.suno.ai/sil-100.mp3"></audio>
    ...player references https://cdn1.suno.ai/${UUID}.mp3 for playback...
    </body></html>`;

  test('extractPageAudioUrl picks the id-matching file, not the silence placeholder', () => {
    const url = extractPageAudioUrl(pageBody, UUID);
    expect(url).toBe(`https://cdn1.suno.ai/${UUID}.mp3`);
    expect(url).not.toContain('sil-100');
  });

  test('T90 fetchMetadata falls back to the public page when the clip API is 503', async () => {
    const adapter = new SunoAdapter({
      fetchJson: async () => ({ statusCode: 503 }), // "Service Suspended", no json
      fetchRaw: async () => ({ statusCode: 200, finalUrl: `https://suno.com/song/${UUID}`, body: pageBody }),
    });
    const res = await adapter.fetchMetadata(parsed);
    expect(res.status).toBe('ok');
    expect(res.metadata.audioUrl).toBe(`https://cdn1.suno.ai/${UUID}.mp3`);
    expect(res.metadata.title).toBe('My Great Track');
    expect(res.metadata.imageUrl).toContain('image_');
  });

  test('T91 auth (403) from the clip API is respected — no page fallback/bypass', async () => {
    let pageFetched = false;
    const adapter = new SunoAdapter({
      fetchJson: async () => ({ statusCode: 403 }),
      fetchRaw: async () => { pageFetched = true; return { statusCode: 200, body: pageBody }; },
    });
    const res = await adapter.fetchMetadata(parsed);
    expect(res.status).toBe('auth_required');
    expect(pageFetched).toBe(false);
  });

  test('page with no matching audio url stays an error (fail closed)', async () => {
    const adapter = new SunoAdapter({
      fetchJson: async () => ({ statusCode: 503 }),
      fetchRaw: async () => ({ statusCode: 200, body: '<html><audio src="https://cdn1.suno.ai/sil-100.mp3"></audio></html>' }),
    });
    const res = await adapter.fetchMetadata(parsed);
    expect(res.status).toBe('error');
  });
});
