'use strict';

/**
 * Suno URL parsing / normalization.
 *
 * This module is Suno-specific but pure (no network, no Electron). It knows
 * only how to recognize a Suno song link and extract a canonical identifier.
 * If it cannot confidently extract an id, it says so — it never guesses.
 */

// Page hosts that Suno serves song pages from.
const SUNO_PAGE_HOSTS = Object.freeze([
  'suno.com',
  'www.suno.com',
  'suno.ai',
  'www.suno.ai',
  'app.suno.ai',
]);

// Canonical UUID (Suno clip ids are UUIDs).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Internal whitespace or ASCII control characters are not allowed in a URL.
// eslint-disable-next-line no-control-regex
const BAD_CHARS_RE = /\s/;

function normalizeHost(host) {
  return String(host || '').toLowerCase().replace(/\.$/, '');
}

/**
 * Parse a single Suno song URL.
 * @param {string} input
 * @returns {{ok: true, id: string, kind: 'song'|'share', canonicalUrl: string, originalUrl: string, host: string}
 *          | {ok: false, reason: string}}
 */
function parseSunoUrl(input) {
  if (typeof input !== 'string') return { ok: false, reason: 'not a string' };
  let raw = input.trim();
  if (!raw) return { ok: false, reason: 'empty' };

  // Reject anything with internal whitespace or control characters.
  if (BAD_CHARS_RE.test(raw)) {
    return { ok: false, reason: 'contains whitespace/control chars' };
  }

  // Allow scheme-less input like "suno.com/song/<id>".
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    raw = 'https://' + raw;
  }

  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'unparseable URL' };
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `unsupported protocol: ${u.protocol}` };
  }

  const host = normalizeHost(u.hostname);
  if (!SUNO_PAGE_HOSTS.includes(host)) {
    return { ok: false, reason: `host not allowed: ${host}` };
  }

  const segments = u.pathname.split('/').filter(Boolean);

  // /song/<id>
  if (segments.length >= 2 && segments[0] === 'song') {
    const id = segments[1];
    if (!UUID_RE.test(id)) {
      return { ok: false, reason: 'song id is not a valid identifier' };
    }
    return {
      ok: true,
      id: id.toLowerCase(),
      kind: 'song',
      canonicalUrl: `https://suno.com/song/${id.toLowerCase()}`,
      originalUrl: input.trim(),
      host,
    };
  }

  // /s/<shortcode> — a share link. We can recognize it but cannot derive the
  // canonical clip id without a network lookup, so we surface the short code
  // and mark it as a share link for the resolver to expand.
  if (segments.length >= 2 && segments[0] === 's') {
    const code = segments[1];
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(code)) {
      return { ok: false, reason: 'share code malformed' };
    }
    return {
      ok: true,
      id: null,
      shareCode: code,
      kind: 'share',
      canonicalUrl: `https://suno.com/s/${code}`,
      originalUrl: input.trim(),
      host,
    };
  }

  return { ok: false, reason: 'not a recognized Suno song path' };
}

/**
 * Parse a block of newline-separated URLs: trim, drop blanks, dedupe.
 * Dedupe is by canonical id when known, else by canonical URL.
 * @param {string} text
 * @returns {{valid: Array<object>, invalid: Array<{input: string, reason: string}>}}
 */
function parseUrlList(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const valid = [];
  const invalid = [];
  const seen = new Set();

  for (const line of lines) {
    const parsed = parseSunoUrl(line);
    if (!parsed.ok) {
      invalid.push({ input: line, reason: parsed.reason });
      continue;
    }
    const key = parsed.id ? `id:${parsed.id}` : `url:${parsed.canonicalUrl}`;
    if (seen.has(key)) continue; // duplicate — silently collapse
    seen.add(key);
    valid.push(parsed);
  }

  return { valid, invalid };
}

module.exports = { parseSunoUrl, parseUrlList, SUNO_PAGE_HOSTS, UUID_RE };
