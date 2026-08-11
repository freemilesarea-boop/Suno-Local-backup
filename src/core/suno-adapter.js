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

class SunoAdapter {
  /**
   * @param {object} deps
   * @param {(url: string) => Promise<{statusCode:number, json?:any, headers?:object}>} deps.fetchJson
   */
  constructor(deps = {}) {
    this.fetchJson = deps.fetchJson;
  }

  /** Validate + normalize a single URL. Returns the url.js parse result. */
  validate(url) {
    return parseSunoUrl(url);
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

module.exports = { SunoAdapter, parseClipMetadata, isSunoHost };
