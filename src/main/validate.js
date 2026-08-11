'use strict';

const fs = require('fs');

/**
 * Pure IPC input validation, kept free of Electron imports so it is unit
 * testable. main.js re-uses these to guard every renderer→main call.
 */

const VALID_FORMATS = new Set(['original', 'mp3', 'wav', 'mp3+wav']);

/**
 * Validate the payload for import:start.
 * @param {any} payload
 * @param {(p:string)=>boolean} [dirExists] - injectable for tests
 * @returns {{ok:true, value:{text:string,format:string,destDir:string}} | {ok:false, error:string}}
 */
function validateStartPayload(payload, dirExists = defaultDirExists) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'Invalid request.' };
  const { text, format, destDir } = payload;
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'No URLs provided.' };
  if (typeof format !== 'string' || !VALID_FORMATS.has(format)) {
    return { ok: false, error: 'Invalid output format.' };
  }
  if (typeof destDir !== 'string' || !destDir.trim()) {
    return { ok: false, error: 'No destination folder selected.' };
  }
  if (!dirExists(destDir)) return { ok: false, error: 'Destination folder does not exist.' };
  return { ok: true, value: { text, format, destDir } };
}

function defaultDirExists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

module.exports = { validateStartPayload, VALID_FORMATS };
