'use strict';

const fs = require('fs');
const path = require('path');
const { ImportController } = require('../../src/core/import-controller');
const { StorageManager } = require('../../src/core/storage');
const { MetadataManager } = require('../../src/core/metadata');
const { Availability } = require('../../src/core/resolver');
const { JobStatus } = require('../../src/core/job');
const { makeTempDir, rmrf } = require('../helpers/fixtures');

const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const UUID2 = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';

function parsedFor(id) {
  return { ok: true, id, kind: 'song', canonicalUrl: `https://suno.com/song/${id}`, originalUrl: `https://suno.com/song/${id}` };
}

function buildController(base, overrides = {}) {
  const resolver = {
    resolve: overrides.resolve ||
      (async () => ({
        state: Availability.AVAILABLE,
        audioUrl: `https://cdn1.suno.ai/${UUID}.mp3`,
        expectedHost: 'cdn1.suno.ai',
        metadata: { id: UUID, title: 'Song', audioUrl: `https://cdn1.suno.ai/${UUID}.mp3`, isPublic: true },
      })),
  };
  const downloader = {
    download: overrides.download ||
      (async ({ destPath }) => {
        fs.writeFileSync(destPath, Buffer.from('FAKEAUDIO'));
        return { path: destPath, bytes: 9, contentType: 'audio/mpeg' };
      }),
  };
  const audio = {
    probe: overrides.probe ||
      (async () => ({ codec: 'mp3', container: 'mp3', duration: 1.0, sampleRate: 44100, channels: 2, bitRate: 128000, sizeBytes: 9 })),
    toMp3: async (src, dest) => { fs.writeFileSync(dest, 'mp3'); return dest; },
    toWav: async (src, dest) => { fs.writeFileSync(dest, 'wav'); return dest; },
  };
  return new ImportController({
    adapter: {},
    resolver,
    downloader,
    audio,
    storage: new StorageManager({ baseDir: base }),
    metadata: new MetadataManager({ baseDir: base }),
    logger: { info() {}, warn() {}, error() {} },
    tmpDir: path.join(base, '.tmp'),
    concurrency: 4,
  });
}

describe('Job state machine', () => {
  let base;
  beforeEach(() => (base = makeTempDir()));
  afterEach(() => rmrf(base));

  test('T31 queued -> completed valid transition', async () => {
    const seen = [];
    const c = buildController(base);
    c.addJobs([parsedFor(UUID)], { format: 'original', onChange: (s) => seen.push(s.status) });
    await c.run();
    expect(c.jobs[0].status).toBe(JobStatus.COMPLETED);
    expect(seen).toContain('RESOLVING');
    expect(seen).toContain('DOWNLOADING');
    expect(seen[seen.length - 1]).toBe('COMPLETED');
    expect(c.jobs[0].outputs.length).toBe(1);
    expect(fs.existsSync(c.jobs[0].outputs[0])).toBe(true);
  });

  test('T32 failure terminates correctly', async () => {
    const c = buildController(base, { resolve: async () => ({ state: Availability.AUTH_REQUIRED }) });
    c.addJobs([parsedFor(UUID)], { format: 'mp3' });
    await c.run();
    expect(c.jobs[0].status).toBe(JobStatus.FAILED);
    expect(c.jobs[0].errorCategory).toBe('AUTH_REQUIRED');
    expect(c.jobs[0].isTerminal()).toBe(true);
  });

  test('T33 failed job can retry (and then succeed)', async () => {
    let attempt = 0;
    const c = buildController(base, {
      resolve: async () => {
        attempt += 1;
        if (attempt === 1) return { state: Availability.NETWORK_ERROR };
        return {
          state: Availability.AVAILABLE,
          audioUrl: `https://cdn1.suno.ai/${UUID}.mp3`,
          expectedHost: 'cdn1.suno.ai',
          metadata: { id: UUID, title: 'Song', isPublic: true },
        };
      },
    });
    c.addJobs([parsedFor(UUID)], { format: 'original' });
    await c.run();
    expect(c.jobs[0].status).toBe(JobStatus.FAILED);
    await c.retryFailed();
    expect(c.jobs[0].status).toBe(JobStatus.COMPLETED);
  });

  test('T34 completed job not retried by retry-failed', async () => {
    const resolveSpy = jest.fn(async () => ({
      state: Availability.AVAILABLE,
      audioUrl: `https://cdn1.suno.ai/${UUID}.mp3`,
      expectedHost: 'cdn1.suno.ai',
      metadata: { id: UUID, title: 'Song', isPublic: true },
    }));
    const c = buildController(base, { resolve: resolveSpy });
    c.addJobs([parsedFor(UUID)], { format: 'original' });
    await c.run();
    expect(c.jobs[0].status).toBe(JobStatus.COMPLETED);
    const callsAfterRun = resolveSpy.mock.calls.length;
    await c.retryFailed();
    expect(resolveSpy.mock.calls.length).toBe(callsAfterRun); // not re-resolved
  });

  test('T35 duplicate gets SKIPPED_DUPLICATE', async () => {
    const c = buildController(base);
    // First import records the track in the index.
    c.addJobs([parsedFor(UUID)], { format: 'original' });
    await c.run();
    // Second controller sharing the same base sees it as a duplicate.
    const c2 = buildController(base);
    c2.addJobs([parsedFor(UUID)], { format: 'original' });
    await c2.run();
    expect(c2.jobs[0].status).toBe(JobStatus.SKIPPED_DUPLICATE);
  });

  test('T36 multiple jobs processed without state corruption', async () => {
    const c = buildController(base);
    c.addJobs([parsedFor(UUID), parsedFor(UUID2)], { format: 'original' });
    await c.run();
    const statuses = c.jobs.map((j) => j.status);
    expect(statuses).toEqual([JobStatus.COMPLETED, JobStatus.COMPLETED]);
    expect(c.jobs[0].trackId).not.toBe(c.jobs[1].trackId);
    expect(c.jobs[0].outputs[0]).not.toBe(c.jobs[1].outputs[0]);
  });
});
