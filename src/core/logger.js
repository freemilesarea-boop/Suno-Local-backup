'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Keys/patterns whose values must never be written to logs.
 * Matches JSON-ish `key: value` / `key=value` and known secret-bearing tokens.
 */
const SENSITIVE_KEY_RE =
  /\b(authorization|cookie|set-cookie|token|access[_-]?token|refresh[_-]?token|session[_-]?id|sessionid|password|passwd|secret|api[_-]?key|apikey|bearer|credential|x-api-key)\b/i;

// Query params that commonly carry signed-URL secrets.
const SIGNED_QUERY_KEYS = /\b(signature|sig|x-amz-signature|x-amz-credential|token|expires|policy|key-pair-id)\b/i;

/**
 * Redact secrets from an arbitrary value (string or object) before logging.
 * Returns a structurally-similar value with sensitive parts replaced.
 */
function redact(value, seen = new WeakSet()) {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((v) => redact(v, seen));

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(k)) {
      out[k] = '[REDACTED]';
    } else if (typeof v === 'string') {
      out[k] = redactString(v);
    } else {
      out[k] = redact(v, seen);
    }
  }
  return out;
}

function redactString(str) {
  let s = str;
  // Redact bearer tokens first (before the key=value pass consumes "Bearer").
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
  // Redact `Authorization: xxx` / `Cookie=yyy` style headers inline. The value
  // class deliberately stops at `&` so a URL query string is not swallowed.
  s = s.replace(
    /\b(authorization|cookie|set-cookie|x-api-key|token|api[_-]?key|password|secret)\b(\s*[:=]\s*)("?)([^\s",;&]+)/gi,
    (m, key, sep, q) => `${key}${sep}${q}[REDACTED]`
  );
  // Redact signed-URL query secrets while keeping the base URL visible.
  s = s.replace(/([?&])([A-Za-z0-9_-]+)=([^&\s]+)/g, (m, amp, key, val) =>
    SIGNED_QUERY_KEYS.test(key) ? `${amp}${key}=[REDACTED]` : m
  );
  return s;
}

class Logger {
  /**
   * @param {object} [opts]
   * @param {string} [opts.filePath] - append JSONL log lines here (optional)
   * @param {boolean} [opts.console] - also mirror to console (default true)
   * @param {() => string} [opts.now] - injectable clock for tests
   */
  constructor(opts = {}) {
    this.filePath = opts.filePath || null;
    this.console = opts.console !== false;
    this.now = opts.now || (() => new Date().toISOString());
    if (this.filePath) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    }
  }

  log(level, event, fields = {}) {
    const entry = {
      ts: this.now(),
      level,
      event,
      ...redact(fields),
    };
    const line = JSON.stringify(entry);
    if (this.filePath) {
      try {
        fs.appendFileSync(this.filePath, line + '\n');
      } catch {
        /* logging must never throw into the pipeline */
      }
    }
    if (this.console) {
      // eslint-disable-next-line no-console
      (level === 'error' ? console.error : console.log)(line);
    }
    return entry;
  }

  info(event, fields) {
    return this.log('info', event, fields);
  }
  warn(event, fields) {
    return this.log('warn', event, fields);
  }
  error(event, fields) {
    return this.log('error', event, fields);
  }
}

module.exports = { Logger, redact, redactString, SENSITIVE_KEY_RE };
