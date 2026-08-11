'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { URL } = require('url');

const { JobStatus, ImportJob, runPool } = require('./job');
const { Availability } = require('./resolver');
const { ErrorCategory } = require('./errors');
const { summarize, auditDetail } = require('./audit');

/**
 * Import Controller — orchestrates the pipeline for each job:
 *
 *   validate → duplicate-check → resolve → download → verify → convert → save
 *
 * It wires together the Suno-specific pieces (adapter, resolver) and the
 * generic pieces (downloader, audio, storage, metadata). All collaborators are
 * injected so the whole pipeline is testable with fixtures/mocks.
 */

const DEFAULT_CONCURRENCY = 3;

function plannedOutputs(format) {
  switch (format) {
    case 'mp3':
      return ['mp3'];
    case 'wav':
      return ['wav'];
    case 'mp3+wav':
      return ['mp3', 'wav'];
    case 'original':
    default:
      return ['original'];
  }
}

function extFromUrl(u) {
  try {
    const p = new URL(u).pathname;
    const m = p.match(/\.([a-z0-9]{2,5})$/i);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

function sourceExtFrom(container, url) {
  const c = (container || '').toLowerCase();
  if (c.includes('mp3')) return 'mp3';
  if (c.includes('wav')) return 'wav';
  if (c.includes('flac')) return 'flac';
  if (c.includes('ogg')) return 'ogg';
  if (c.includes('mp4') || c.includes('m4a') || c.includes('aac')) return 'm4a';
  return extFromUrl(url) || 'audio';
}

class ImportController {
  /**
   * @param {object} deps
   * @param {import('./suno-adapter').SunoAdapter} deps.adapter
   * @param {import('./resolver').SourceResolver} deps.resolver
   * @param {import('./downloader').Downloader} deps.downloader
   * @param {import('./audio').AudioProcessor} deps.audio
   * @param {import('./storage').StorageManager} deps.storage
   * @param {import('./metadata').MetadataManager} deps.metadata
   * @param {import('./logger').Logger} deps.logger
   * @param {string} [deps.tmpDir]
   * @param {number} [deps.concurrency]
   */
  constructor(deps = {}) {
    this.adapter = deps.adapter;
    this.resolver = deps.resolver;
    this.downloader = deps.downloader;
    this.audio = deps.audio;
    this.storage = deps.storage;
    this.metadata = deps.metadata;
    this.logger = deps.logger || { info() {}, warn() {}, error() {} };
    this.concurrency = deps.concurrency || DEFAULT_CONCURRENCY;
    this.tmpDir = deps.tmpDir || path.join(os.tmpdir(), 'ver-booster');
    // Optional, read-only provenance auditor. When absent, nothing changes.
    this.auditor = deps.auditor || null;
    this.jobs = [];
  }

  /** Create jobs from parsed url results. */
  addJobs(parsedList, { format = 'original', onChange } = {}) {
    const created = [];
    for (const parsed of parsedList) {
      const job = new ImportJob({ url: parsed.originalUrl || parsed.canonicalUrl, parsed, format, onChange });
      this.jobs.push(job);
      created.push(job);
    }
    return created;
  }

  /** Process all non-terminal jobs with bounded concurrency. */
  async run() {
    const pending = this.jobs.filter((j) => j.status === JobStatus.QUEUED);
    await runPool(pending, this.concurrency, (job) => this.processJob(job));
    return this.jobs.map((j) => j.snapshot());
  }

  /** Reset only FAILED jobs and reprocess them (completed jobs untouched). */
  async retryFailed() {
    const failed = this.jobs.filter((j) => j.status === JobStatus.FAILED);
    for (const j of failed) {
      j.set(JobStatus.QUEUED, { errorCategory: null, errorMessage: null, progress: null });
    }
    await runPool(failed, this.concurrency, (job) => this.processJob(job));
    return this.jobs.map((j) => j.snapshot());
  }

  async processJob(job) {
    const log = (event, extra) =>
      this.logger.info(event, { jobId: job.id, trackId: job.trackId, ...extra });
    try {
      // 1. VALIDATE
      job.set(JobStatus.VALIDATING);
      if (!job.parsed || job.parsed.ok === false) {
        log('validate.fail', { stage: 'VALIDATING', result: 'INVALID_URL' });
        return job.fail(ErrorCategory.INVALID_URL, 'The link is not a valid Suno song URL.');
      }

      // 2. DUPLICATE (Layer 1 by track id)
      if (job.trackId && this.metadata && (await this.metadata.hasTrack(job.trackId))) {
        log('duplicate.skip', { stage: 'VALIDATING', result: 'SKIPPED_DUPLICATE' });
        return job.set(JobStatus.SKIPPED_DUPLICATE, {
          errorCategory: ErrorCategory.DUPLICATE,
          errorMessage: 'This track has already been imported.',
        });
      }

      // 3. RESOLVE
      job.set(JobStatus.RESOLVING);
      const resolution = await this.resolver.resolve(job.parsed);
      if (resolution.metadata) {
        job.metadata = resolution.metadata;
        job.title = resolution.metadata.title || job.title;
      }
      const mapped = mapResolution(resolution.state);
      if (mapped) {
        log('resolve.blocked', { stage: 'RESOLVING', result: resolution.state });
        return job.fail(mapped.category, mapped.message);
      }
      // Backfill the canonical track id (share links start with a null id) so
      // duplicate detection and metadata records key off the real clip id.
      if (!job.trackId && resolution.metadata && resolution.metadata.id) {
        job.trackId = resolution.metadata.id;
      }
      // Duplicate check by canonical id — catches share URLs that resolve to an
      // already-imported song (Layer 1, post-resolution).
      if (job.trackId && this.metadata && (await this.metadata.hasTrack(job.trackId))) {
        log('duplicate.skip', { stage: 'RESOLVING', result: 'SKIPPED_DUPLICATE' });
        return job.set(JobStatus.SKIPPED_DUPLICATE, {
          errorCategory: ErrorCategory.DUPLICATE,
          errorMessage: 'This track has already been imported.',
        });
      }
      log('resolve.ok', { stage: 'RESOLVING', result: 'AVAILABLE' });

      // 4. DOWNLOAD (to temp)
      job.set(JobStatus.DOWNLOADING);
      job.setProgress(null); // indeterminate until we see content-length
      await fsp.mkdir(this.tmpDir, { recursive: true });
      const srcGuessExt = extFromUrl(resolution.audioUrl) || 'mp3';
      const tmpSource = path.join(this.tmpDir, `${job.id}.src.${srcGuessExt}`);
      await this.downloader.download({
        url: resolution.audioUrl,
        expectedHost: resolution.expectedHost,
        destPath: tmpSource,
        onProgress: ({ received, total }) => {
          job.setProgress(total ? Math.min(received / total, 1) : null);
        },
      });
      log('download.ok', { stage: 'DOWNLOADING', result: 'OK' });

      // 5. VERIFY (real audio via ffprobe)
      job.set(JobStatus.VERIFYING);
      let info;
      try {
        info = await this.audio.probe(tmpSource);
      } catch (e) {
        await safeUnlink(tmpSource);
        log('verify.fail', { stage: 'VERIFYING', result: 'INVALID_AUDIO', error: e.code });
        return job.fail(ErrorCategory.INVALID_AUDIO, 'The downloaded file was not valid audio.');
      }
      const sourceExt = sourceExtFrom(info.container, resolution.audioUrl);

      // 6. CONVERT + 7. SAVE
      job.set(JobStatus.CONVERTING);
      const track = { id: job.trackId, title: job.metadata && job.metadata.title };
      const base = require('./storage').trackBaseName(track, { includeId: true });
      const outputs = [];
      const wanted = plannedOutputs(job.format);

      for (const kind of wanted) {
        if (kind === 'original') {
          const dest = await this.storage.allocatePath(base, sourceExt, { subDir: 'original' });
          await fsp.copyFile(tmpSource, dest);
          outputs.push(dest);
        } else if (kind === 'mp3') {
          const dest = await this.storage.allocatePath(base, 'mp3', {});
          if (sourceExt === 'mp3') {
            await fsp.copyFile(tmpSource, dest); // avoid needless transcode
          } else {
            await this.audio.toMp3(tmpSource, dest);
          }
          outputs.push(dest);
        } else if (kind === 'wav') {
          const dest = await this.storage.allocatePath(base, 'wav', {});
          await this.audio.toWav(tmpSource, dest);
          outputs.push(dest);
        }
      }

      job.set(JobStatus.SAVING);
      job.outputs = outputs;

      // Metadata sidecar + index record.
      if (this.metadata && job.trackId) {
        const sidecar = await this.storage.allocatePath(base, 'json', {});
        const record = {
          id: job.trackId,
          url: (job.metadata && job.metadata.url) || job.parsed.canonicalUrl,
          title: job.metadata && job.metadata.title,
          createdAt: job.metadata && job.metadata.createdAt,
          importedAt: new Date().toISOString(),
          sourceFormat: sourceExt,
          outputFormat: job.format,
          duration: info.duration,
          sampleRate: info.sampleRate,
          channels: info.channels,
          codec: info.codec,
          container: info.container,
          imageUrl: job.metadata && job.metadata.imageUrl,
          outputs: outputs.map((p) => path.relative(this.storage.baseDir, p)),
        };
        await this.metadata.record(record, sidecar);
      }

      await safeUnlink(tmpSource);
      log('complete', { stage: 'COMPLETED', result: 'COMPLETED' });
      job.set(JobStatus.COMPLETED, { progress: 1 });

      // Independent, read-only provenance audit. Its outcome NEVER changes the
      // COMPLETED download status; failures are captured in job.audit only.
      if (this.auditor) {
        try {
          await this._auditOutputs(job, outputs);
        } catch (e) {
          this.logger.warn('audit.error', { jobId: job.id, message: e && e.message });
          job.setAudit({ status: 'AUDIT_FAILED', error: 'audit failed', files: [] });
        }
      }
      return job;
    } catch (err) {
      const category = classifyError(err);
      this.logger.error('job.error', {
        jobId: job.id,
        trackId: job.trackId,
        stage: job.status,
        errorCategory: category,
        message: err && err.message ? err.message : String(err),
      });
      return job.fail(category, userMessageFor(category));
    }
  }

  /**
   * Run the read-only audit on every produced file and aggregate a compact
   * summary onto the job (surfaced in the UI). No `.audit.json` sidecar is
   * written to disk. Read-only: the audited files are never modified.
   */
  async _auditOutputs(job, outputs) {
    const source = {
      service: 'Suno',
      url: job.parsed && job.parsed.canonicalUrl,
      trackId: job.trackId,
      importedAt: new Date().toISOString(),
      originalFilename: job.metadata && job.metadata.title,
    };
    const files = [];
    for (const out of outputs) {
      const isOriginal = /(^|[\\/])original[\\/]/.test(out);
      // Audit runs in-memory only (surfaced in the UI via job.audit). No
      // `.audit.json` sidecar is written to disk next to the extracted audio.
      const report = await this.auditor.audit(out, { source, isOriginal });
      files.push({ file: path.basename(out), isOriginal, summary: summarize(report), detail: auditDetail(report) });
    }
    const anyFailed = files.some((f) => f.summary.status === 'AUDIT_FAILED');
    const anyPartial = files.some((f) => f.summary.status === 'AUDIT_PARTIAL');
    const status = anyFailed ? 'AUDIT_PARTIAL' : anyPartial ? 'AUDIT_PARTIAL' : 'AUDIT_COMPLETE';
    job.setAudit({ status, files });
    this.logger.info('audit.done', { jobId: job.id, trackId: job.trackId, status });
  }
}

function mapResolution(state) {
  switch (state) {
    case Availability.AVAILABLE:
      return null; // proceed
    case Availability.AUTH_REQUIRED:
      return { category: ErrorCategory.AUTH_REQUIRED, message: 'This track requires you to be signed in to Suno to access it.' };
    case Availability.POLICY_BLOCKED:
      return { category: ErrorCategory.POLICY_BLOCKED, message: 'This track cannot be imported due to access restrictions.' };
    case Availability.NOT_AVAILABLE:
      return { category: ErrorCategory.SOURCE_NOT_AVAILABLE, message: 'No downloadable audio is available for this track.' };
    case Availability.UNSUPPORTED:
      return { category: ErrorCategory.UNSUPPORTED, message: 'This kind of link is not supported.' };
    case Availability.NETWORK_ERROR:
      return { category: ErrorCategory.NETWORK_ERROR, message: 'A network problem occurred. Please try again.' };
    case Availability.UNKNOWN:
    default:
      // Fail closed: unknown is never treated as available.
      return { category: ErrorCategory.SOURCE_NOT_AVAILABLE, message: 'No downloadable audio is available for this track.' };
  }
}

function classifyError(err) {
  const code = err && err.code;
  if (code === 'CANCELLED') return ErrorCategory.INTERNAL_ERROR;
  if (code === 'NOT_AUDIO' || code === 'ZERO_BYTE') return ErrorCategory.INVALID_AUDIO;
  if (code === 'CONVERT_FAILED') return ErrorCategory.CONVERSION_FAILED;
  if (code === 'PROBE_FAILED' || code === 'NO_AUDIO_STREAM' || code === 'BAD_DURATION') return ErrorCategory.INVALID_AUDIO;
  if (code === 'HOST_NOT_ALLOWED' || code === 'PRIVATE_HOST' || code === 'BAD_PROTOCOL') return ErrorCategory.POLICY_BLOCKED;
  if (code === 'TIMEOUT' || code === 'REQ_ERROR' || code === 'RES_ERROR' || code === 'NET_ERROR') return ErrorCategory.NETWORK_ERROR;
  if (code && code.startsWith && code.startsWith('HTTP_')) return ErrorCategory.DOWNLOAD_FAILED;
  if (err && err.name === 'DownloadError') return ErrorCategory.DOWNLOAD_FAILED;
  if (err && (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'ENOSPC')) return ErrorCategory.STORAGE_ERROR;
  return ErrorCategory.INTERNAL_ERROR;
}

function userMessageFor(category) {
  const { USER_MESSAGES } = require('./errors');
  return USER_MESSAGES[category] || USER_MESSAGES.INTERNAL_ERROR;
}

async function safeUnlink(p) {
  try {
    await fsp.unlink(p);
  } catch {
    /* ignore */
  }
}

module.exports = { ImportController, plannedOutputs, sourceExtFrom, mapResolution, classifyError };
