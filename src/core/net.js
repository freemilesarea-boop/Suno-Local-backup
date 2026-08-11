'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

/**
 * Low-level network helpers with built-in SSRF protection.
 *
 * The central safety rule: every request must pass a `hostAllowed(host)`
 * predicate. Callers (resolver / downloader) supply an explicit allowlist so
 * arbitrary user-controlled URLs can never be turned into a generic fetcher.
 * Non-http(s) protocols are always rejected.
 */

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_REDIRECTS = 5;

function transportFor(protocol) {
  if (protocol === 'https:') return https;
  if (protocol === 'http:') return http;
  return null;
}

/**
 * Returns true if a hostname is obviously local / private and must never be
 * reached via a user-supplied URL. This is a defense-in-depth check layered
 * on top of the explicit allowlist.
 */
function isLocalOrPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '0.0.0.0' || h === '::' || h === '[::]' || h === '::1' || h === '[::1]') return true;
  // IPv4 literal checks.
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local
    if (a === 0) return true;
  }
  // IPv6 unique-local / link-local literals.
  if (h.startsWith('[fc') || h.startsWith('[fd') || h.startsWith('[fe80')) return true;
  return false;
}

class NetError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'NetError';
    this.code = code || 'NET_ERROR';
  }
}

/**
 * Validate a URL against protocol + host policy. Throws NetError on violation.
 * @param {string} rawUrl
 * @param {(host: string) => boolean} hostAllowed
 * @param {boolean} [allowPrivate] - test-only escape hatch
 * @returns {URL}
 */
function validateUrl(rawUrl, hostAllowed, allowPrivate = false) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new NetError(`unparseable URL`, 'BAD_URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new NetError(`protocol not allowed: ${u.protocol}`, 'BAD_PROTOCOL');
  }
  const host = u.hostname.toLowerCase();
  if (!allowPrivate && isLocalOrPrivateHost(host)) {
    throw new NetError(`host is local/private: ${host}`, 'PRIVATE_HOST');
  }
  if (typeof hostAllowed === 'function' && !hostAllowed(host)) {
    throw new NetError(`host not in allowlist: ${host}`, 'HOST_NOT_ALLOWED');
  }
  return u;
}

/**
 * Perform a GET and buffer the response body (bounded). Follows redirects,
 * re-validating each hop against the host policy.
 *
 * @param {string} rawUrl
 * @param {object} opts
 * @param {(host: string)=>boolean} opts.hostAllowed
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxRedirects]
 * @param {number} [opts.maxBytes]
 * @param {boolean} [opts.allowPrivate]
 * @param {object} [opts.headers]
 * @param {object} [opts._transport] - injectable {http, https} for tests
 * @returns {Promise<{statusCode:number, headers:object, body:Buffer, finalUrl:string}>}
 */
function getBuffered(rawUrl, opts = {}) {
  const {
    hostAllowed,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    maxBytes = 8 * 1024 * 1024,
    allowPrivate = false,
    headers = {},
  } = opts;

  return new Promise((resolve, reject) => {
    let redirects = 0;

    const go = (currentUrl) => {
      let u;
      try {
        u = validateUrl(currentUrl, hostAllowed, allowPrivate);
      } catch (e) {
        return reject(e);
      }
      const transport = (opts._transport && opts._transport[u.protocol === 'https:' ? 'https' : 'http'])
        || transportFor(u.protocol);

      const req = transport.get(
        u,
        { headers: { 'user-agent': 'VerBooster/0.1', accept: '*/*', ...headers } },
        (res) => {
          const { statusCode } = res;
          // Handle redirects.
          if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
            res.resume(); // drain
            if (redirects >= maxRedirects) {
              return reject(new NetError('too many redirects', 'TOO_MANY_REDIRECTS'));
            }
            redirects += 1;
            let next;
            try {
              next = new URL(res.headers.location, u).toString();
            } catch {
              return reject(new NetError('bad redirect location', 'BAD_REDIRECT'));
            }
            return go(next);
          }

          const chunks = [];
          let total = 0;
          res.on('data', (c) => {
            total += c.length;
            if (total > maxBytes) {
              req.destroy();
              return reject(new NetError('response too large', 'TOO_LARGE'));
            }
            chunks.push(c);
          });
          res.on('end', () => {
            resolve({
              statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks),
              finalUrl: u.toString(),
            });
          });
          res.on('error', (e) => reject(new NetError(e.message, 'RES_ERROR')));
        }
      );

      req.setTimeout(timeoutMs, () => {
        req.destroy(new NetError('request timed out', 'TIMEOUT'));
      });
      req.on('error', (e) => {
        if (e instanceof NetError) return reject(e);
        reject(new NetError(e.message, 'REQ_ERROR'));
      });
    };

    go(rawUrl);
  });
}

module.exports = {
  getBuffered,
  validateUrl,
  isLocalOrPrivateHost,
  NetError,
  transportFor,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_REDIRECTS,
};
