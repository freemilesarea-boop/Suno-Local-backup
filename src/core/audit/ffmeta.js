'use strict';

const { resolveFfprobePath, run } = require('../ffmpeg');
const { redactEvidence } = require('./scan');

/**
 * Deep, read-only metadata extraction via the bundled ffprobe. Collects the
 * FULL tag map (format + every stream) rather than a hard-coded subset, plus
 * the technical stream descriptors used for forensic features.
 */
class FfprobeMeta {
  constructor(deps = {}) {
    this.ffprobePath = deps.ffprobePath || resolveFfprobePath();
    this.run = deps.run || run;
  }

  async analyze(filePath) {
    if (!this.ffprobePath) return { ok: false, error: 'ffprobe not available' };
    let json;
    try {
      const res = await this.run(this.ffprobePath, [
        '-v', 'error',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        '-show_chapters',
        filePath,
      ]);
      json = JSON.parse(res.stdout || '{}');
    } catch (e) {
      return { ok: false, error: `ffprobe failed: ${e.message}` };
    }

    const format = json.format || {};
    const streams = Array.isArray(json.streams) ? json.streams : [];
    const audio = streams.find((s) => s.codec_type === 'audio') || {};

    // Canonicalized tag map from format + all stream tag blocks.
    const tags = {};
    const collect = (block, scope) => {
      if (block && typeof block === 'object') {
        for (const [k, v] of Object.entries(block)) {
          tags[`${scope}.${k.toLowerCase()}`] = redactEvidence(String(v));
        }
      }
    };
    collect(format.tags, 'format');
    streams.forEach((s, idx) => collect(s.tags, `stream${idx}`));

    return {
      ok: true,
      technical: {
        container: (format.format_name || '').split(',')[0] || null,
        formatLongName: format.format_long_name || null,
        codec: audio.codec_name || null,
        codecLongName: audio.codec_long_name || null,
        codecTag: audio.codec_tag_string || null,
        profile: audio.profile || null,
        sampleFmt: audio.sample_fmt || null,
        sampleRate: audio.sample_rate ? Number(audio.sample_rate) : null,
        channels: audio.channels != null ? Number(audio.channels) : null,
        channelLayout: audio.channel_layout || null,
        bitRate: format.bit_rate ? Number(format.bit_rate) : audio.bit_rate ? Number(audio.bit_rate) : null,
        duration: Number(format.duration || audio.duration || 0) || null,
      },
      tags,
      chapters: Array.isArray(json.chapters) ? json.chapters.length : 0,
    };
  }
}

module.exports = { FfprobeMeta };
