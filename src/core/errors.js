'use strict';

/**
 * Error categories surfaced to the UI. Each maps to a stable user-facing
 * message. Internal debug detail is carried separately and never shown raw.
 */
const ErrorCategory = Object.freeze({
  INVALID_URL: 'INVALID_URL',
  TRACK_NOT_FOUND: 'TRACK_NOT_FOUND',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  SOURCE_NOT_AVAILABLE: 'SOURCE_NOT_AVAILABLE',
  NETWORK_ERROR: 'NETWORK_ERROR',
  DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
  INVALID_AUDIO: 'INVALID_AUDIO',
  CONVERSION_FAILED: 'CONVERSION_FAILED',
  STORAGE_ERROR: 'STORAGE_ERROR',
  DUPLICATE: 'DUPLICATE',
  UNSUPPORTED: 'UNSUPPORTED',
  POLICY_BLOCKED: 'POLICY_BLOCKED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
});

const USER_MESSAGES = Object.freeze({
  INVALID_URL: 'The link is not a valid Suno song URL.',
  TRACK_NOT_FOUND: 'This track could not be found.',
  AUTH_REQUIRED: 'This track requires you to be signed in to Suno to access it.',
  SOURCE_NOT_AVAILABLE: 'No downloadable audio is available for this track.',
  NETWORK_ERROR: 'A network problem occurred. Please try again.',
  DOWNLOAD_FAILED: 'The download did not complete successfully.',
  INVALID_AUDIO: 'The downloaded file was not valid audio.',
  CONVERSION_FAILED: 'Audio conversion failed.',
  STORAGE_ERROR: 'The file could not be saved to the selected folder.',
  DUPLICATE: 'This track has already been imported.',
  UNSUPPORTED: 'This kind of link is not supported.',
  POLICY_BLOCKED: 'This track cannot be imported due to access restrictions.',
  INTERNAL_ERROR: 'An unexpected error occurred.',
});

/**
 * An application error with a stable category. `message` is a safe internal
 * debug string; `userMessage()` returns the sanitized user-facing text.
 */
class ImportError extends Error {
  /**
   * @param {string} category - one of ErrorCategory
   * @param {string} [message] - internal debug message (must be pre-sanitized)
   * @param {object} [options]
   * @param {Error} [options.cause]
   */
  constructor(category, message, options = {}) {
    super(message || category);
    this.name = 'ImportError';
    this.category = ErrorCategory[category] ? category : ErrorCategory.INTERNAL_ERROR;
    if (options.cause) this.cause = options.cause;
  }

  userMessage() {
    return USER_MESSAGES[this.category] || USER_MESSAGES.INTERNAL_ERROR;
  }

  static is(err) {
    return err instanceof ImportError;
  }

  /** Coerce any thrown value into an ImportError. */
  static from(err, fallbackCategory = ErrorCategory.INTERNAL_ERROR) {
    if (err instanceof ImportError) return err;
    const msg = err && err.message ? String(err.message) : String(err);
    return new ImportError(fallbackCategory, msg, { cause: err });
  }
}

module.exports = { ErrorCategory, USER_MESSAGES, ImportError };
