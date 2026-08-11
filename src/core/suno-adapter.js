'use strict';

const { parseSunoUrl } = require('./url');

/**
 * Suno Adapter.
 *
 * The ONLY Suno-specific knowledge in the pipeline lives here and in url.js:
 *  - URL validation / normalization / identifier extraction
 *  - Parsing publicly-available clip metadata into a typed SunoTrackMetadata
 *
 * It performs no downloads and makes no availability/authorization decision —
 * that belongs to the Source Resolver. If Suno's web structure changes, this
 * file (plus resolver.js) is where the change is contained.
 *
 * All network I/O is injected as `fetchJson(url) -> {statusCode, json, headers}`
 * so the adapter is fully testable with fixtures and never talks to a live
 * service in unit tests.
 */

// Hosts we consider Suno-owned. Audio/metadata must live under one of these.
function isSunoHost(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  return (
    h === 'suno.ai' ||
    h === 'suno.com' ||
    h.endsWith('.suno.ai') ||
    h.endsWith('.suno.com')
  );
}

/**
 * @typedef {Object} SunoTrackMetadata
 * @property {string} id
 * @property {string} url            canonical page url
 * @property {string} [title]
 * @property {string} [createdAt]
 * @property {string} [imageUrl]
 * @property {number} [duration]     seconds
 * @property {string} [audioUrl]     candidate public audio url (unverified)
 * @property {boolean} [isPublic]
 * @property {string} [status]
 */

/**
 * Pure parser: map a raw Suno clip JSON object into SunoTrackMetadata.
 * Missing fields are left undefined. Never fabricates data.
 *
 * @param {object} raw
 * @param {{id?: string, canonicalUrl?: string}} [ctx]
 * @returns {SunoTrackMetadata}
 */
function parseClipMetadata(raw, ctx = {}) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('metadata is not an object');
  }
  const id = String(raw.id || ctx.id || '').trim();
  if (!id) throw new Error('metadata missing clip id');

  const meta = raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {};

  const durationRaw =
    firstDefined(raw.duration, meta.duration, raw.audio_duration, meta.audio_duration);
  const duration = toPositiveNumber(durationRaw);

  const isPublic = firstDefined(raw.is_public, raw.isPublic, raw.public);

  const out = {
    id,
    url: ctx.canonicalUrl || `https://suno.com/song/${id}`,
  };

  const title = cleanString(firstDefined(raw.title, raw.display_name, meta.title));
  if (title) out.title = title;

  const createdAt = cleanString(firstDefined(raw.created_at, raw.createdAt, raw.create_time));
  if (createdAt) out.createdAt = createdAt;

  const imageUrl = cleanString(firstDefined(raw.image_url, raw.image_large_url, raw.imageUrl));
  if (imageUrl) out.imageUrl = imageUrl;

  const audioUrl = cleanString(firstDefined(raw.audio_url, raw.audioUrl, raw.mp3_url));
  if (audioUrl) out.audioUrl = audioUrl;

  if (duration != null) out.duration = duration;
  if (typeof isPublic === 'boolean') out.isPublic = isPublic;

  const status = cleanString(raw.status);
  if (status) out.status = status;

  return out;
}

function firstDefined(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== '') return v;
  return undefined;
}
function cleanString(v) {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s.length ? s : undefined;
}
function toPositiveNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Extract a canonical Suno song id (UUID) from a page's HTML or a final URL.
// Looks at <link rel="canonical">, og:url, and any /song/<uuid> occurrence.
const CANONICAL_SONG_RE =
  /\/song\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function extractCanonicalId(finalUrl, body) {
  // 1. Prefer the final (post-redirect) URL if it is already a canonical song URL.
  if (finalUrl) {
    const m = String(finalUrl).match(CANONICAL_SONG_RE);
    if (m) return m[1].toLowerCase();
  }
  // 2. Fall back to canonical/og:url tags, then any /song/<uuid> in the HTML.
  const html = body ? String(body) : '';
  if (html) {
    const canonical = html.match(
      /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i
    );
    if (canonical && canonical[1]) {
      const m = canonical[1].match(CANONICAL_SONG_RE);
      if (m) return m[1].toLowerCase();
    }
    const og = html.match(
      /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i
    );
    if (og && og[1]) {
      const m = og[1].match(CANONICAL_SONG_RE);
      if (m) return m[1].toLowerCase();
    }
    const any = html.match(CANONICAL_SONG_RE);
    if (any) return any[1].toLowerCase();
  }
  return null;
}

class SunoAdapter {
  /**
   * @param {object} deps
   * @param {(url: string) => Promise<{statusCode:number, json?:any, headers?:object}>} deps.fetchJson
   * @param {(url: string) => Promise<{statusCode:number, headers?:object, body?:Buffer|string, finalUrl?:string}>} [deps.fetchRaw]
   *        Follows redirects (Suno hosts only) and returns the final URL + body.
   */
  constructor(deps = {}) {
    this.fetchJson = deps.fetchJson;
    this.fetchRaw = deps.fetchRaw;
  }

  /** Validate + normalize a single URL. Returns the url.js parse result. */
  validate(url) {
    return parseSunoUrl(url);
  }

  /**
   * Resolve a `/s/<code>` share link to its canonical song via normal public
   * behavior: follow Suno's public redirect(s) and/or read the public page's
   * canonical metadata. No auth, no private API — just what a browser sees.
   *
   * @param {{shareCode:string, canonicalUrl:string, originalUrl?:string}} parsed
   * @returns {Promise<{ok:true, id:string, kind:'song', canonicalUrl:string, originalUrl:string, host:string}
   *          | {ok:false, reason:string}>}
   */
  async resolveShareLink(parsed) {
    if (typeof this.fetchRaw !== 'function') {
      return { ok: false, reason: 'no fetchRaw dependency' };
    }
    if (!parsed || !parsed.shareCode) {
      return { ok: false, reason: 'missing share code' };
    }
    const shareUrl = `https://suno.com/s/${parsed.shareCode}`;
    let res;
    try {
      res = await this.fetchRaw(shareUrl);
    } catch (e) {
      return { ok: false, reason: `share fetch error: ${e.code || e.message}` };
    }
    if (res.statusCode === 401 || res.statusCode === 403) {
      return { ok: false, reason: `auth required (${res.statusCode})`, authRequired: true };
    }
    if (res.statusCode === 404) {
      return { ok: false, reason: 'share link not found (404)' };
    }
    const id = extractCanonicalId(res.finalUrl, res.body);
    if (!id) {
      // A share link that lands on the Suno home page (rather than a song) is
      // one that isn't publicly resolvable without a signed-in session. We fail
      // closed and never attempt to bypass that.
      let homeRedirect = false;
      try {
        const fu = new URL(res.finalUrl);
        homeRedirect = fu.hostname.endsWith('suno.com') && (fu.pathname === '/' || fu.pathname === '');
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        reason: homeRedirect
          ? 'share link redirected to Suno home (public resolution not available)'
          : 'could not derive canonical song id from share link',
      };
    }
    return {
      ok: true,
      id,
      kind: 'song',
      canonicalUrl: `https://suno.com/song/${id}`,
      originalUrl: parsed.originalUrl || shareUrl,
      host: 'suno.com',
    };
  }

  /** Candidate public metadata endpoints for a clip id, most-preferred first. */
  metadataEndpoints(id) {
    return [
      `https://studio-api.suno.ai/api/clip/${id}`,
      `https://studio-api.suno.com/api/clip/${id}`,
    ];
  }

  /**
   * Fetch + parse public metadata for a validated song URL.
   * @param {{id: string, canonicalUrl: string}} parsed
   * @returns {Promise<{status:'ok'|'not_found'|'auth_required'|'error', metadata?:SunoTrackMetadata, statusCode?:number, detail?:string}>}
   */
  async fetchMetadata(parsed) {
    if (typeof this.fetchJson !== 'function') {
      throw new Error('SunoAdapter requires a fetchJson dependency');
    }
    if (!parsed || !parsed.id) {
      return { status: 'error', detail: 'missing clip id' };
    }

    let lastDetail = 'no endpoint responded';
    for (const endpoint of this.metadataEndpoints(parsed.id)) {
      let res;
      try {
        res = await this.fetchJson(endpoint);
      } catch (e) {
        lastDetail = `fetch error: ${e.code || e.message}`;
        continue; // try next endpoint
      }
      const code = res.statusCode;
      if (code === 401 || code === 403) {
        return { status: 'auth_required', statusCode: code };
      }
      if (code === 404) {
        return { status: 'not_found', statusCode: code };
      }
      if (code >= 200 && code < 300 && res.json) {
        try {
          const metadata = parseClipMetadata(res.json, {
            id: parsed.id,
            canonicalUrl: parsed.canonicalUrl,
          });
          return { status: 'ok', metadata, statusCode: code };
        } catch (e) {
          return { status: 'error', statusCode: code, detail: `parse failed: ${e.message}` };
        }
      }
      lastDetail = `unexpected status ${code}`;
    }
    return { status: 'error', detail: lastDetail };
  }
}

module.exports = { SunoAdapter, parseClipMetadata, isSunoHost, extractCanonicalId };
