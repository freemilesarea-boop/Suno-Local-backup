'use strict';

const { URL } = require('url');
const { isSunoHost } = require('./suno-adapter');

/**
 * Source Resolver.
 *
 * Decides whether a track has an audio source the user can legitimately access
 * right now, and — only when it does — hands the Downloader an explicit,
 * host-constrained audio URL.
 *
 * FAIL CLOSED is the governing rule:
 *  - Unknown / uncertain states are NEVER treated as AVAILABLE.
 *  - We only ever use the audio URL that Suno's own public metadata returns.
 *  - We NEVER forge signed URLs, re-sign expired ones, manipulate auth headers,
 *    brute-force endpoints, or bypass any access control. If we can't verify
 *    legitimate access, we return NOT_AVAILABLE / POLICY_BLOCKED / AUTH_REQUIRED.
 */

const Availability = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  NOT_AVAILABLE: 'NOT_AVAILABLE',
  UNSUPPORTED: 'UNSUPPORTED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  POLICY_BLOCKED: 'POLICY_BLOCKED',
  UNKNOWN: 'UNKNOWN',
});

class SourceResolver {
  /**
   * @param {object} deps
   * @param {import('./suno-adapter').SunoAdapter} deps.adapter
   */
  constructor(deps = {}) {
    this.adapter = deps.adapter;
  }

  /**
   * @param {object} parsed - a successful url.js parse result
   * @returns {Promise<{state:string, audioUrl?:string, expectedHost?:string, metadata?:object, detail?:string}>}
   */
  async resolve(parsed) {
    if (!parsed || parsed.ok === false) {
      return { state: Availability.UNSUPPORTED, detail: 'invalid parse result' };
    }

    // Share links (`/s/<code>`) are expanded to their canonical song via normal
    // public redirect / canonical metadata before resolving availability.
    if (parsed.kind === 'share' || !parsed.id) {
      if (parsed.kind !== 'share' || !parsed.shareCode) {
        return { state: Availability.UNSUPPORTED, detail: 'unsupported link form' };
      }
      let expanded;
      try {
        expanded = await this.adapter.resolveShareLink(parsed);
      } catch (e) {
        return { state: Availability.NETWORK_ERROR, detail: `share resolve error: ${e.message}` };
      }
      if (!expanded || expanded.ok === false) {
        if (expanded && expanded.authRequired) {
          return { state: Availability.AUTH_REQUIRED, detail: expanded.reason };
        }
        return { state: Availability.NOT_AVAILABLE, detail: (expanded && expanded.reason) || 'share resolution failed' };
      }
      // Continue with the canonical song parse result.
      parsed = expanded;
    }

    let result;
    try {
      result = await this.adapter.fetchMetadata(parsed);
    } catch (e) {
      return { state: Availability.NETWORK_ERROR, detail: e.message };
    }

    switch (result.status) {
      case 'auth_required':
        // The user is not authorized for this content in their current context.
        return { state: Availability.AUTH_REQUIRED, detail: `status ${result.statusCode}` };
      case 'not_found':
        return { state: Availability.NOT_AVAILABLE, detail: 'track not found' };
      case 'error':
        // Could not obtain trustworthy metadata → never assume available.
        return { state: Availability.UNKNOWN, detail: result.detail || 'metadata error' };
      case 'ok':
        return this._decideFromMetadata(result.metadata);
      default:
        return { state: Availability.UNKNOWN, detail: 'unrecognized resolver result' };
    }
  }

  _decideFromMetadata(metadata) {
    if (!metadata) return { state: Availability.UNKNOWN, detail: 'no metadata' };

    // Explicitly private → block. Never attempt to bypass.
    if (metadata.isPublic === false) {
      return {
        state: Availability.POLICY_BLOCKED,
        metadata,
        detail: 'track is marked private',
      };
    }

    const audioUrl = metadata.audioUrl;
    if (!audioUrl) {
      return { state: Availability.NOT_AVAILABLE, metadata, detail: 'no audio url in metadata' };
    }

    let host;
    try {
      const u = new URL(audioUrl);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') {
        return { state: Availability.NOT_AVAILABLE, metadata, detail: 'non-http audio url' };
      }
      host = u.hostname.toLowerCase();
    } catch {
      return { state: Availability.NOT_AVAILABLE, metadata, detail: 'unparseable audio url' };
    }

    // The audio URL must live on a Suno-owned host. Anything else is refused so
    // the resolver can never be tricked into approving an arbitrary download.
    if (!isSunoHost(host)) {
      return {
        state: Availability.NOT_AVAILABLE,
        metadata,
        detail: `audio host not Suno-owned: ${host}`,
      };
    }

    return {
      state: Availability.AVAILABLE,
      audioUrl,
      expectedHost: host,
      metadata,
    };
  }
}

module.exports = { SourceResolver, Availability };
