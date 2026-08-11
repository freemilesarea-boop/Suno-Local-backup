'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { URL } = require('url');
const { isSunoHost } = require('./suno-adapter');
const { isLocalOrPrivateHost, transportFor, NetError } = require('./net');

/**
 * Generic file Downloader — deliberately Suno-agnostic.
 *
 * Guarantees:
 *  - Never writes directly to the final path. Data streams to `<dest>.part`
 *    and is only atomically renamed to `<dest>` after passing sanity checks.
 *  - Bounded retries with backoff; hard request timeout; bounded redirects.
 *  - Every hop is host-validated. A user-supplied URL cannot be turned into an
 *    arbitrary fetcher (no file://, no localhost/private ranges, host must be
 *    allowed). This is the SSRF guard.
 *  - Rejects zero-byte responses and obvious HTML/JSON error pages.
 *  - Cleans up the temp file on failure — an incomplete download is never left
 *    looking like a finished one.
 */

const DEFAULTS = {
  timeoutMs: 30000,
  maxRetries: 3,
  maxRedirects: 5,
  maxBytes: 512 * 1024 * 1024, // 512 MB ceiling
};

class DownloadError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DownloadError';
    this.code = code || 'DOWNLOAD_FAILED';
  }
}

function looksLikeHtmlOrJson(buf) {
  if (!buf || !buf.length) return false;
  // Skip a UTF-8 BOM.
  let i = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) i = 3;
  // Skip leading ASCII whitespace.
  while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0a || buf[i] === 0x0d)) i++;
  const c = buf[i];
  // '<' (HTML/XML) or '{' / '[' (JSON error payloads)
  return c === 0x3c || c === 0x7b || c === 0x5b;
}

function contentTypeIsNonAudio(ct) {
  if (!ct) return false;
  const t = String(ct).toLowerCase();
  return (
    t.includes('text/html') ||
    t.includes('application/json') ||
    t.includes('application/xml') ||
    t.includes('text/xml') ||
    t.startsWith('text/')
  );
}

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

class Downloader {
  /**
   * @param {object} [opts]
   * @param {(ms:number)=>Promise<void>} [opts.sleep] - injectable backoff
   * @param {{http:object, https:object}} [opts.transport] - injectable for tests
   */
  constructor(opts = {}) {
    this.sleep = opts.sleep || sleepDefault;
    this.transport = opts.transport || null;
  }

  /**
   * @param {object} job
   * @param {string} job.url
   * @param {string} job.destPath - final path; a sibling `.part` is used as temp
   * @param {string} [job.expectedHost] - resolver-approved host
   * @param {(info:{received:number,total:number|null})=>void} [job.onProgress]
   * @param {AbortSignal} [job.signal]
   * @param {(host:string)=>boolean} [job.hostAllowed] - overrides default policy (tests)
   * @param {boolean} [job.allowPrivate] - test-only escape hatch
   * @param {number} [job.timeoutMs]
   * @param {number} [job.maxRetries]
   * @returns {Promise<{path:string, bytes:number, contentType:string|null}>}
   */
  async download(job) {
    const cfg = { ...DEFAULTS, ...job };
    const destPath = job.destPath;
    if (!destPath) throw new DownloadError('destPath required', 'BAD_ARGS');
    const partPath = destPath + '.part';

    const hostAllowed =
      job.hostAllowed ||
      ((h) => (job.expectedHost ? h === job.expectedHost || isSunoHost(h) : isSunoHost(h)));
    const allowPrivate = job.allowPrivate === true;

    await fsp.mkdir(path.dirname(destPath), { recursive: true });

    let lastErr;
    for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
      if (job.signal && job.signal.aborted) {
        throw new DownloadError('cancelled', 'CANCELLED');
      }
      try {
        const result = await this._attempt(job.url, {
          partPath,
          hostAllowed,
          allowPrivate,
          timeoutMs: cfg.timeoutMs,
          maxBytes: cfg.maxBytes,
          maxRedirects: cfg.maxRedirects,
          onProgress: job.onProgress,
          signal: job.signal,
        });

        // Sanity checks before finalize.
        if (result.bytes === 0) {
          throw new DownloadError('zero-byte download', 'ZERO_BYTE');
        }
        if (contentTypeIsNonAudio(result.contentType) || result.htmlSniff) {
          throw new DownloadError('response was not audio (html/json)', 'NOT_AUDIO');
        }

        // Atomic finalize: rename temp → final only after checks pass.
        await fsp.rename(partPath, destPath);
        return { path: destPath, bytes: result.bytes, contentType: result.contentType };
      } catch (err) {
        lastErr = err;
        await this._cleanup(partPath);
        // Do not retry on non-transient / policy errors.
        if (err.code === 'CANCELLED' || err.code === 'NOT_AUDIO' || err.code === 'ZERO_BYTE'
          || err.code === 'BAD_PROTOCOL' || err.code === 'HOST_NOT_ALLOWED' || err.code === 'PRIVATE_HOST') {
          throw err;
        }
        if (attempt < cfg.maxRetries) {
          await this.sleep(Math.min(2000 * 2 ** attempt, 16000));
          continue;
        }
      }
    }
    throw lastErr || new DownloadError('download failed', 'DOWNLOAD_FAILED');
  }

  _validate(rawUrl, hostAllowed, allowPrivate) {
    let u;
    try {
      u = new URL(rawUrl);
    } catch {
      throw new DownloadError('unparseable URL', 'BAD_URL');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new DownloadError(`protocol not allowed: ${u.protocol}`, 'BAD_PROTOCOL');
    }
    const host = u.hostname.toLowerCase();
    if (!allowPrivate && isLocalOrPrivateHost(host)) {
      throw new DownloadError(`host is local/private: ${host}`, 'PRIVATE_HOST');
    }
    if (!hostAllowed(host)) {
      throw new DownloadError(`host not allowed: ${host}`, 'HOST_NOT_ALLOWED');
    }
    return u;
  }

  _attempt(rawUrl, o) {
    return new Promise((resolve, reject) => {
      let redirects = 0;
      let settled = false;
      const done = (fn, arg) => {
        if (settled) return;
        settled = true;
        fn(arg);
      };

      const go = (currentUrl) => {
        let u;
        try {
          u = this._validate(currentUrl, o.hostAllowed, o.allowPrivate);
        } catch (e) {
          return done(reject, e);
        }
        const transport =
          (this.transport && this.transport[u.protocol === 'https:' ? 'https' : 'http']) ||
          transportFor(u.protocol);

        const req = transport.get(
          u,
          { headers: { 'user-agent': 'VerBooster/0.1', accept: '*/*' } },
          (res) => {
            const { statusCode } = res;
            if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
              res.resume();
              if (redirects >= o.maxRedirects) {
                return done(reject, new DownloadError('too many redirects', 'TOO_MANY_REDIRECTS'));
              }
              redirects += 1;
              let next;
              try {
                next = new URL(res.headers.location, u).toString();
              } catch {
                return done(reject, new DownloadError('bad redirect', 'BAD_REDIRECT'));
              }
              return go(next);
            }
            if (statusCode < 200 || statusCode >= 300) {
              res.resume();
              return done(
                reject,
                new DownloadError(`http status ${statusCode}`, statusCode >= 500 ? 'HTTP_5XX' : 'HTTP_4XX')
              );
            }

            const contentType = res.headers['content-type'] || null;
            const totalHeader = res.headers['content-length'];
            const total = totalHeader != null ? Number(totalHeader) : null;
            let received = 0;
            let firstChunk = null;

            const out = fs.createWriteStream(o.partPath);
            const fail = (err) => {
              out.destroy();
              req.destroy();
              done(reject, err);
            };

            const onAbort = () => fail(new DownloadError('cancelled', 'CANCELLED'));
            if (o.signal) {
              if (o.signal.aborted) return fail(new DownloadError('cancelled', 'CANCELLED'));
              o.signal.addEventListener('abort', onAbort, { once: true });
            }

            res.on('data', (chunk) => {
              if (firstChunk === null) firstChunk = chunk.subarray(0, Math.min(chunk.length, 64));
              received += chunk.length;
              if (received > o.maxBytes) {
                return fail(new DownloadError('response too large', 'TOO_LARGE'));
              }
              if (o.onProgress) o.onProgress({ received, total: Number.isFinite(total) ? total : null });
            });
            res.on('error', (e) => fail(new DownloadError(e.message, 'RES_ERROR')));
            res.on('aborted', () => fail(new DownloadError('connection aborted', 'ABORTED')));
            out.on('error', (e) => fail(new DownloadError(e.message, 'WRITE_ERROR')));
            out.on('finish', () => {
              if (o.signal) o.signal.removeEventListener('abort', onAbort);
              // Content-Length sanity check.
              if (Number.isFinite(total) && total > 0 && received !== total) {
                return done(reject, new DownloadError(`size mismatch ${received}/${total}`, 'SIZE_MISMATCH'));
              }
              done(resolve, {
                bytes: received,
                contentType,
                htmlSniff: looksLikeHtmlOrJson(firstChunk),
              });
            });
            res.pipe(out);
          }
        );

        req.setTimeout(o.timeoutMs, () => {
          req.destroy(new DownloadError('request timed out', 'TIMEOUT'));
        });
        req.on('error', (e) => {
          if (e instanceof DownloadError) return done(reject, e);
          done(reject, new DownloadError(e.message, 'REQ_ERROR'));
        });
      };

      go(rawUrl);
    });
  }

  async _cleanup(partPath) {
    try {
      await fsp.unlink(partPath);
    } catch {
      /* ignore missing temp file */
    }
  }
}

module.exports = { Downloader, DownloadError, looksLikeHtmlOrJson, contentTypeIsNonAudio };
