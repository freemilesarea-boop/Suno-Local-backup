'use strict';

const { SunoAdapter, parseClipMetadata, isSunoHost } = require('../../src/core/suno-adapter');

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
