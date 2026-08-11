'use strict';

/**
 * Live integration smoke test (NOT a unit test — talks to the real Suno service).
 *
 * Usage:  node scripts/live-smoke.js "<suno-url>" [format] [outDir]
 *         SHARE_URL env var is used if no URL argument is given.
 *
 * It exercises the real pipeline end to end and prints evidence:
 *   parse -> share-link resolution -> metadata -> availability -> download
 *   -> ffprobe(source) -> WAV(+ffprobe) -> MP3(+ffprobe) -> duplicate check
 *
 * It NEVER prints signed-URL query secrets (only host/path of audio sources),
 * and it does not upload any audio. If the source is not legitimately available
 * it reports the fail-closed state and exits non-zero WITHOUT attempting any
 * bypass.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

const { parseSunoUrl } = require('../src/core/url');
const { SunoAdapter } = require('../src/core/suno-adapter');
const { SourceResolver, Availability } = require('../src/core/resolver');
const { AudioProcessor } = require('../src/core/audio');
const { createController } = require('../src/core/factory');
const { sunoFetchJson, sunoFetchRaw } = require('../src/core/factory');
const { Logger } = require('../src/core/logger');
const { JobStatus } = require('../src/core/job');

function safeAudioLoc(u) {
  try {
    const parsed = new URL(u);
    return `${parsed.host}${parsed.pathname}`; // no query (may hold signed secrets)
  } catch {
    return '(unparseable)';
  }
}

async function main() {
  const url = process.argv[2] || process.env.SHARE_URL;
  const format = process.argv[3] || 'mp3+wav';
  const outDir = process.argv[4] || fs.mkdtempSync(path.join(os.tmpdir(), 'suno-live-'));

  if (!url) {
    console.error('No URL provided (arg or SHARE_URL env).');
    process.exit(2);
  }
  console.log('=== SUNO LIVE SMOKE ===');
  console.log('format:', format);
  console.log('outDir:', outDir);

  // STEP 4: parse / normalization
  const parsed = parseSunoUrl(url);
  console.log('\n[parse]', JSON.stringify({ ok: parsed.ok, kind: parsed.kind, shareCode: parsed.shareCode, id: parsed.id }));
  if (!parsed.ok) {
    console.error('URL did not parse as a Suno link:', parsed.reason);
    process.exit(1);
  }

  const adapter = new SunoAdapter({ fetchJson: sunoFetchJson, fetchRaw: sunoFetchRaw });
  const resolver = new SourceResolver({ adapter });

  // STEP 2 + 5: share-link resolution (real redirect/canonical)
  let songParsed = parsed;
  if (parsed.kind === 'share') {
    const expanded = await adapter.resolveShareLink(parsed);
    console.log('[share-resolve]', JSON.stringify({ ok: expanded.ok, id: expanded.id, reason: expanded.reason, authRequired: expanded.authRequired }));
    if (!expanded.ok) {
      console.error('SHARE_RESOLUTION_FAILED — not bypassing.');
      process.exit(1);
    }
    songParsed = expanded;
  }
  console.log('[canonical]', songParsed.canonicalUrl, 'trackId=', songParsed.id);

  // STEP 6: live metadata
  const meta = await adapter.fetchMetadata(songParsed);
  console.log('[metadata]', JSON.stringify({
    status: meta.status,
    title: meta.metadata && meta.metadata.title,
    duration: meta.metadata && meta.metadata.duration,
    hasAudioUrl: !!(meta.metadata && meta.metadata.audioUrl),
    audioLoc: meta.metadata && meta.metadata.audioUrl ? safeAudioLoc(meta.metadata.audioUrl) : null,
  }));

  // STEP 7: source resolution
  const resolution = await resolver.resolve(parsed);
  console.log('[resolution]', JSON.stringify({ state: resolution.state, expectedHost: resolution.expectedHost, detail: resolution.detail }));
  if (resolution.state !== Availability.AVAILABLE) {
    console.error(`LIVE_SOURCE_NOT_AVAILABLE: ${resolution.state} — not bypassing.`);
    process.exit(3);
  }

  // STEP 8-10: real import (download -> verify -> convert -> save)
  const logger = new Logger({ console: false });
  const controller = createController({ baseDir: outDir, logger });
  controller.addJobs([songParsed], { format });
  await controller.run();
  const job = controller.jobs[0];
  console.log('[import]', JSON.stringify({ status: job.status, errorCategory: job.errorCategory, outputs: job.outputs.map((p) => path.basename(p)) }));
  if (job.status !== JobStatus.COMPLETED) {
    console.error('IMPORT_DID_NOT_COMPLETE');
    process.exit(4);
  }

  const audio = new AudioProcessor();
  for (const out of job.outputs) {
    const info = await audio.probe(out);
    const size = fs.statSync(out).size;
    console.log(`[ffprobe] ${path.basename(out)} ->`, JSON.stringify({
      codec: info.codec, container: info.container, duration: info.duration,
      sampleRate: info.sampleRate, channels: info.channels, bitRate: info.bitRate, sizeBytes: size,
    }));
  }

  // STEP 11: duplicate — re-run the SAME url; must be SKIPPED_DUPLICATE by canonical id.
  const controller2 = createController({ baseDir: outDir, logger });
  controller2.addJobs([songParsed], { format });
  await controller2.run();
  console.log('[duplicate]', JSON.stringify({ status: controller2.jobs[0].status }));
  if (controller2.jobs[0].status !== JobStatus.SKIPPED_DUPLICATE) {
    console.error('DUPLICATE_NOT_DETECTED');
    process.exit(5);
  }

  console.log('\nLIVE_SUNO_IMPORT = PASS');
}

main().catch((e) => {
  console.error('LIVE_SMOKE_ERROR:', e && e.message ? e.message : String(e));
  process.exit(10);
});
