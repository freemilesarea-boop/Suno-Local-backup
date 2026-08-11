'use strict';

/**
 * Import job state model + a small bounded-concurrency runner.
 *
 * The queue supports arbitrarily many jobs (e.g. 100+ URLs) while only running
 * a conservative number concurrently. This keeps the UI responsive and avoids
 * hammering the source. Concurrency is intentionally conservative — it is NOT a
 * knob for evading any rate limit.
 */

const JobStatus = Object.freeze({
  QUEUED: 'QUEUED',
  VALIDATING: 'VALIDATING',
  RESOLVING: 'RESOLVING',
  DOWNLOADING: 'DOWNLOADING',
  VERIFYING: 'VERIFYING',
  CONVERTING: 'CONVERTING',
  SAVING: 'SAVING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  SKIPPED_DUPLICATE: 'SKIPPED_DUPLICATE',
  CANCELLED: 'CANCELLED',
});

const TERMINAL = new Set([
  JobStatus.COMPLETED,
  JobStatus.FAILED,
  JobStatus.SKIPPED_DUPLICATE,
  JobStatus.CANCELLED,
]);

function isTerminal(status) {
  return TERMINAL.has(status);
}

let SEQ = 0;

class ImportJob {
  /**
   * @param {object} init
   * @param {string} init.url - the original input url
   * @param {object} [init.parsed] - url.js parse result
   * @param {string} [init.format] - requested output format id
   * @param {(job: ImportJob) => void} [init.onChange]
   */
  constructor(init) {
    SEQ += 1;
    this.id = `job-${SEQ}`;
    this.url = init.url;
    this.parsed = init.parsed || null;
    this.format = init.format || 'original';
    this.status = JobStatus.QUEUED;
    this.progress = null; // null => indeterminate; number 0..1 => determinate
    this.trackId = init.parsed && init.parsed.id ? init.parsed.id : null;
    this.title = null;
    this.errorCategory = null;
    this.errorMessage = null; // user-facing
    this.outputs = []; // absolute paths produced
    this.metadata = null;
    this._onChange = typeof init.onChange === 'function' ? init.onChange : null;
  }

  set(status, patch = {}) {
    this.status = status;
    Object.assign(this, patch);
    if (this._onChange) this._onChange(this.snapshot());
    return this;
  }

  setProgress(progress) {
    this.progress = progress;
    if (this._onChange) this._onChange(this.snapshot());
  }

  fail(category, userMessage) {
    return this.set(JobStatus.FAILED, { errorCategory: category, errorMessage: userMessage });
  }

  isTerminal() {
    return isTerminal(this.status);
  }

  /** Serializable view for IPC / UI. */
  snapshot() {
    return {
      id: this.id,
      url: this.url,
      trackId: this.trackId,
      title: this.title,
      format: this.format,
      status: this.status,
      progress: this.progress,
      errorCategory: this.errorCategory,
      errorMessage: this.errorMessage,
      outputs: this.outputs.slice(),
    };
  }
}

/**
 * Run `worker(item)` over items with a fixed max concurrency. Resolves when all
 * items settle. Worker rejections are captured per-item and do not abort others.
 * @param {Array<T>} items
 * @param {number} concurrency
 * @param {(item:T, index:number)=>Promise<any>} worker
 * @returns {Promise<Array<{ok:boolean, value?:any, error?:any}>>}
 * @template T
 */
async function runPool(items, concurrency, worker) {
  const list = Array.from(items);
  const results = new Array(list.length);
  const limit = Math.max(1, Math.min(concurrency || 1, 64));
  let next = 0;

  async function drain() {
    while (next < list.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await worker(list[i], i) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  }

  const runners = [];
  for (let k = 0; k < Math.min(limit, list.length); k++) runners.push(drain());
  await Promise.all(runners);
  return results;
}

module.exports = { JobStatus, ImportJob, isTerminal, runPool };
