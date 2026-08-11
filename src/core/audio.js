'use strict';

const path = require('path');
const fs = require('fs');
const { resolveFfmpegPath, resolveFfprobePath, run } = require('./ffmpeg');

/**
 * Audio Converter / Validator — generic, not Suno-specific.
 *
 * Uses the bundled ffprobe to *prove* a file is real audio (not just trust the
 * extension) and ffmpeg to convert to MP3 / WAV. All process invocations use
 * argument arrays (no shell), so filenames are safe.
 *
 * Honesty rules:
 *  - Converting a lossy source to WAV is a container/PCM change, NOT quality
 *    restoration. We never claim otherwise.
 *  - Sample rate and channel layout are preserved by default (no needless
 *    resampling / remixing).
 */

const OutputFormat = Object.freeze({
  ORIGINAL: 'original',
  MP3: 'mp3',
  WAV: 'wav',
});

class AudioError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AudioError';
    this.code = code || 'AUDIO_ERROR';
  }
}

class AudioProcessor {
  /**
   * @param {object} [deps]
   * @param {string} [deps.ffmpegPath]
   * @param {string} [deps.ffprobePath]
   * @param {typeof run} [deps.run] - injectable for tests
   */
  constructor(deps = {}) {
    this.ffmpegPath = deps.ffmpegPath || resolveFfmpegPath();
    this.ffprobePath = deps.ffprobePath || resolveFfprobePath();
    this.run = deps.run || run;
  }

  /**
   * Probe a file. Returns a typed summary or throws AudioError if it is not
   * recognizable audio.
   * @param {string} filePath
   * @returns {Promise<{codec:string, container:string, duration:number, sampleRate:number|null, channels:number|null, bitRate:number|null, sizeBytes:number}>}
   */
  async probe(filePath) {
    if (!this.ffprobePath) throw new AudioError('ffprobe not available', 'NO_FFPROBE');
    let out;
    try {
      const res = await this.run(this.ffprobePath, [
        '-v', 'error',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        filePath,
      ]);
      out = JSON.parse(res.stdout || '{}');
    } catch (e) {
      throw new AudioError(`probe failed: ${e.message}`, 'PROBE_FAILED');
    }

    const streams = Array.isArray(out.streams) ? out.streams : [];
    const audio = streams.find((s) => s.codec_type === 'audio');
    if (!audio) throw new AudioError('no audio stream found', 'NO_AUDIO_STREAM');

    const format = out.format || {};
    const duration = Number(format.duration || audio.duration || 0);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new AudioError('audio has non-positive duration', 'BAD_DURATION');
    }

    let sizeBytes = Number(format.size || 0);
    if (!sizeBytes) {
      try {
        sizeBytes = fs.statSync(filePath).size;
      } catch {
        sizeBytes = 0;
      }
    }

    return {
      codec: audio.codec_name || null,
      container: (format.format_name || '').split(',')[0] || null,
      duration,
      sampleRate: audio.sample_rate ? Number(audio.sample_rate) : null,
      channels: audio.channels != null ? Number(audio.channels) : null,
      bitRate: format.bit_rate ? Number(format.bit_rate) : audio.bit_rate ? Number(audio.bit_rate) : null,
      sizeBytes,
    };
  }

  /** True if the file is decodable audio with positive duration. */
  async isValidAudio(filePath) {
    try {
      await this.probe(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Convert to WAV (PCM). Preserves source sample rate & channels by default.
   * @param {string} src
   * @param {string} dest
   * @param {object} [opts] {signal}
   * @returns {Promise<string>} dest
   */
  async toWav(src, dest, opts = {}) {
    if (!this.ffmpegPath) throw new AudioError('ffmpeg not available', 'NO_FFMPEG');
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    const tmp = dest + '.part';
    try {
      await this.run(
        this.ffmpegPath,
        [
          '-hide_banner', '-loglevel', 'error',
          '-y',
          '-i', src,
          '-vn',
          '-c:a', 'pcm_s16le',
          '-f', 'wav',
          tmp,
        ],
        { signal: opts.signal }
      );
    } catch (e) {
      await safeUnlink(tmp);
      throw new AudioError(`wav conversion failed: ${e.message}`, 'CONVERT_FAILED');
    }
    await fs.promises.rename(tmp, dest);
    return dest;
  }

  /**
   * Convert to MP3. Uses a high-quality VBR preset unless overridden.
   * @param {string} src
   * @param {string} dest
   * @param {object} [opts] {signal, quality}
   * @returns {Promise<string>} dest
   */
  async toMp3(src, dest, opts = {}) {
    if (!this.ffmpegPath) throw new AudioError('ffmpeg not available', 'NO_FFMPEG');
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    const tmp = dest + '.part';
    const quality = opts.quality != null ? String(opts.quality) : '2'; // libmp3lame VBR ~190kbps
    try {
      await this.run(
        this.ffmpegPath,
        [
          '-hide_banner', '-loglevel', 'error',
          '-y',
          '-i', src,
          '-vn',
          '-c:a', 'libmp3lame',
          '-q:a', quality,
          '-f', 'mp3',
          tmp,
        ],
        { signal: opts.signal }
      );
    } catch (e) {
      await safeUnlink(tmp);
      throw new AudioError(`mp3 conversion failed: ${e.message}`, 'CONVERT_FAILED');
    }
    await fs.promises.rename(tmp, dest);
    return dest;
  }
}

async function safeUnlink(p) {
  try {
    await fs.promises.unlink(p);
  } catch {
    /* ignore */
  }
}

module.exports = { AudioProcessor, AudioError, OutputFormat };
