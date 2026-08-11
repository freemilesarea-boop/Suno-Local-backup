'use strict';

const { SourceResolver, Availability } = require('../../src/core/resolver');

const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const parsed = { ok: true, id: UUID, kind: 'song', canonicalUrl: `https://suno.com/song/${UUID}` };

function resolverWith(fetchResult, shareResult) {
  const adapter = {
    fetchMetadata: async () => fetchResult,
    resolveShareLink: async () => shareResult,
  };
  return new SourceResolver({ adapter });
}

describe('SourceResolver availability decisions', () => {
  test('AVAILABLE when public metadata gives a Suno-hosted audio url', async () => {
    const r = await resolverWith({
      status: 'ok',
      metadata: { id: UUID, audioUrl: `https://cdn1.suno.ai/${UUID}.mp3`, isPublic: true },
    }).resolve(parsed);
    expect(r.state).toBe(Availability.AVAILABLE);
    expect(r.expectedHost).toBe('cdn1.suno.ai');
  });

  test('T15 resolver failure mapped correctly: auth_required -> AUTH_REQUIRED', async () => {
    const r = await resolverWith({ status: 'auth_required', statusCode: 403 }).resolve(parsed);
    expect(r.state).toBe(Availability.AUTH_REQUIRED);
  });

  test('T43 private track fails closed (POLICY_BLOCKED)', async () => {
    const r = await resolverWith({
      status: 'ok',
      metadata: { id: UUID, audioUrl: `https://cdn1.suno.ai/${UUID}.mp3`, isPublic: false },
    }).resolve(parsed);
    expect(r.state).toBe(Availability.POLICY_BLOCKED);
  });

  test('T44 unknown metadata state never becomes AVAILABLE', async () => {
    const r = await resolverWith({ status: 'error', detail: 'garbage' }).resolve(parsed);
    expect(r.state).toBe(Availability.UNKNOWN);
    expect(r.state).not.toBe(Availability.AVAILABLE);
  });

  test('non-Suno audio host refused (NOT_AVAILABLE)', async () => {
    const r = await resolverWith({
      status: 'ok',
      metadata: { id: UUID, audioUrl: 'https://evil.example.com/track.mp3', isPublic: true },
    }).resolve(parsed);
    expect(r.state).toBe(Availability.NOT_AVAILABLE);
  });

  test('missing audio url -> NOT_AVAILABLE', async () => {
    const r = await resolverWith({ status: 'ok', metadata: { id: UUID, isPublic: true } }).resolve(parsed);
    expect(r.state).toBe(Availability.NOT_AVAILABLE);
  });

  test('not_found -> NOT_AVAILABLE', async () => {
    const r = await resolverWith({ status: 'not_found' }).resolve(parsed);
    expect(r.state).toBe(Availability.NOT_AVAILABLE);
  });

  test('share link resolves to canonical song then becomes AVAILABLE', async () => {
    const r = await resolverWith(
      { status: 'ok', metadata: { id: UUID, audioUrl: `https://cdn1.suno.ai/${UUID}.mp3`, isPublic: true } },
      { ok: true, id: UUID, kind: 'song', canonicalUrl: `https://suno.com/song/${UUID}` }
    ).resolve({ ok: true, kind: 'share', shareCode: 'abcd', canonicalUrl: 'https://suno.com/s/abcd', id: null });
    expect(r.state).toBe(Availability.AVAILABLE);
    expect(r.metadata.id).toBe(UUID);
  });

  test('share link that cannot be resolved fails closed (NOT_AVAILABLE)', async () => {
    const r = await resolverWith(
      { status: 'error' },
      { ok: false, reason: 'could not derive canonical song id' }
    ).resolve({ ok: true, kind: 'share', shareCode: 'abcd', canonicalUrl: 'https://suno.com/s/abcd', id: null });
    expect(r.state).toBe(Availability.NOT_AVAILABLE);
  });

  test('share link requiring auth maps to AUTH_REQUIRED (fail closed)', async () => {
    const r = await resolverWith(
      { status: 'error' },
      { ok: false, reason: 'auth required (403)', authRequired: true }
    ).resolve({ ok: true, kind: 'share', shareCode: 'abcd', canonicalUrl: 'https://suno.com/s/abcd', id: null });
    expect(r.state).toBe(Availability.AUTH_REQUIRED);
  });
});
