'use strict';

const { classifyError } = require('../../src/core/import-controller');
const { ErrorCategory, USER_MESSAGES } = require('../../src/core/errors');

describe('classifyError: audio 403/401 -> SOURCE_BLOCKED (honest signed-URL message)', () => {
  test('HTTP_FORBIDDEN maps to SOURCE_BLOCKED (not generic DOWNLOAD_FAILED)', () => {
    expect(classifyError({ name: 'DownloadError', code: 'HTTP_FORBIDDEN' })).toBe(ErrorCategory.SOURCE_BLOCKED);
  });

  test('other HTTP_* still map to DOWNLOAD_FAILED', () => {
    expect(classifyError({ name: 'DownloadError', code: 'HTTP_4XX' })).toBe(ErrorCategory.DOWNLOAD_FAILED);
    expect(classifyError({ name: 'DownloadError', code: 'HTTP_5XX' })).toBe(ErrorCategory.DOWNLOAD_FAILED);
  });

  test('SOURCE_BLOCKED has a distinct, actionable user message', () => {
    const msg = USER_MESSAGES.SOURCE_BLOCKED;
    expect(msg).toBeTruthy();
    expect(msg).not.toBe(USER_MESSAGES.DOWNLOAD_FAILED);
    expect(msg.toLowerCase()).toContain('signed url');
    expect(msg.toLowerCase()).toContain('download'); // points to the official Download
  });
});
