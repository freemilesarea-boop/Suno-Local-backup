'use strict';

const { SunoAdapter, isSunoHost } = require('./suno-adapter');
const { SourceResolver } = require('./resolver');
const { Downloader } = require('./downloader');
const { AudioProcessor } = require('./audio');
const { StorageManager } = require('./storage');
const { MetadataManager } = require('./metadata');
const { ImportController } = require('./import-controller');
const { getBuffered } = require('./net');

/**
 * Real fetchJson used by the adapter in production. Constrained to Suno-owned
 * hosts via the SSRF-safe net layer, so metadata lookups can never be pointed
 * at an arbitrary or private host.
 */
async function sunoFetchJson(url) {
  const res = await getBuffered(url, {
    hostAllowed: isSunoHost,
    timeoutMs: 20000,
    maxBytes: 4 * 1024 * 1024,
  });
  let json;
  const ct = String(res.headers['content-type'] || '');
  if (ct.includes('application/json') || looksJson(res.body)) {
    try {
      json = JSON.parse(res.body.toString('utf8'));
    } catch {
      json = undefined;
    }
  }
  return { statusCode: res.statusCode, headers: res.headers, json };
}

function looksJson(buf) {
  if (!buf || !buf.length) return false;
  let i = 0;
  while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0a || buf[i] === 0x0d)) i++;
  return buf[i] === 0x7b || buf[i] === 0x5b; // { or [
}

/**
 * Real fetchRaw used by the adapter to expand `/s/<code>` share links. Follows
 * redirects but ONLY to Suno-owned hosts (the SSRF-safe net layer enforces the
 * host allowlist + private-range block on every hop), returning the final URL
 * and the page body so a canonical song id can be extracted.
 */
async function sunoFetchRaw(url) {
  const res = await getBuffered(url, {
    hostAllowed: isSunoHost,
    timeoutMs: 20000,
    maxBytes: 4 * 1024 * 1024,
    maxRedirects: 5,
  });
  return {
    statusCode: res.statusCode,
    headers: res.headers,
    body: res.body,
    finalUrl: res.finalUrl,
  };
}

/**
 * Build a fully-wired production ImportController.
 * @param {object} opts
 * @param {string} opts.baseDir - user-selected output directory
 * @param {import('./logger').Logger} opts.logger
 * @param {number} [opts.concurrency]
 * @param {string} [opts.tmpDir]
 */
function createController(opts) {
  const adapter = new SunoAdapter({ fetchJson: sunoFetchJson, fetchRaw: sunoFetchRaw });
  const resolver = new SourceResolver({ adapter });
  const downloader = new Downloader();
  const audio = new AudioProcessor();
  const storage = new StorageManager({ baseDir: opts.baseDir });
  const metadata = new MetadataManager({ baseDir: opts.baseDir });
  return new ImportController({
    adapter,
    resolver,
    downloader,
    audio,
    storage,
    metadata,
    logger: opts.logger,
    concurrency: opts.concurrency,
    tmpDir: opts.tmpDir,
  });
}

module.exports = { createController, sunoFetchJson, sunoFetchRaw };
