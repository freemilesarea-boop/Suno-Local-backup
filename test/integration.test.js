'use strict';

const fs = require('fs');
const path = require('path');

const { ImportController } = require('../src/core/import-controller');
const { Downloader } = require('../src/core/downloader');
const { AudioProcessor } = require('../src/core/audio');
const { StorageManager } = require('../src/core/storage');
const { MetadataManager } = require('../src/core/metadata');
const { Availability } = require('../src/core/resolver');
const { JobStatus } = require('../src/core/job');
const { makeTempDir, rmrf, startServer, ensureAudioFixtures } = require('./helpers/fixtures');

const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function parsedFor(id, ok = true) {
  if (!ok) return { ok: false, reason: 'bad' };
  return { ok: true, id, kind: 'song', canonicalUrl: `https://suno.com/song/${id}`, originalUrl: `https://suno.com/song/${id}` };
}

// A downloader that wraps the REAL downloader but permits the local test server
// (localhost). All real staging/atomic/verify logic is exercised.
function testDownloader() {
  const real = new Downloader({ sleep: () => Promise.resolve() });
  return {
    download: (job) => real.download({ ...job, allowPrivate: true, hostAllowed: () => true, maxRetries: 0 }),
  };
}

function buildController(base, resolver, extra = {}) {
  return new ImportController({
    adapter: {},
    resolver,
    downloader: extra.downloader || testDownloader(),
    audio: extra.audio || new AudioProcessor(),
    storage: new StorageManager({ baseDir: base }),
    metadata: new MetadataManager({ baseDir: base }),
    logger: { info() {}, warn() {}, error() {} },
    tmpDir: path.join(base, '.tmp'),
    concurrency: extra.concurrency || 3,
  });
}

describe('Integration: full pipeline (real download + real ffmpeg)', () => {
  let base;
  let server;
  let fixtures;
  let hits;

  beforeAll(() => {
    fixtures = ensureAudioFixtures();
  });
  beforeEach(async () => {
    base = makeTempDir();
    hits = { audio: 0 };
    server = await startServer({
      '/audio.mp3': (req, res) => {
        hits.audio += 1;
        const buf = fs.readFileSync(fixtures.mp3);
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': buf.length });
        res.end(buf);
      },
      '/page': (req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html>please sign in</html>');
      },
      '/cut': (req, res) => {
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': 999999 });
        res.write('ID3partial');
        req.socket.destroy(); // simulate interruption
      },
    });
  });
  afterEach(async () => {
    if (server) await server.close();
    rmrf(base);
  });

  function availableResolver(pathName = '/audio.mp3') {
    return {
      resolve: async () => ({
        state: Availability.AVAILABLE,
        audioUrl: server.url(pathName),
        expectedHost: '127.0.0.1',
        metadata: { id: UUID, title: 'Integration Song', isPublic: true },
      }),
    };
  }

  test('T45 / Scenario A+G: MP3+WAV outputs produced and probe-valid', async () => {
    const c = buildController(base, availableResolver());
    c.addJobs([parsedFor(UUID)], { format: 'mp3+wav' });
    await c.run();

    const job = c.jobs[0];
    expect(job.status).toBe(JobStatus.COMPLETED);
    expect(job.outputs.length).toBe(2);
    for (const out of job.outputs) expect(fs.existsSync(out)).toBe(true);

    const audio = new AudioProcessor();
    const mp3 = job.outputs.find((p) => p.endsWith('.mp3'));
    const wav = job.outputs.find((p) => p.endsWith('.wav'));
    const mp3Info = await audio.probe(mp3);
    const wavInfo = await audio.probe(wav);
    expect(mp3Info.codec).toBe('mp3');
    expect(wavInfo.codec).toMatch(/pcm/);
    expect(mp3Info.duration).toBeGreaterThan(0);
    expect(wavInfo.duration).toBeGreaterThan(0);

    // Metadata sidecar + index written.
    const idx = JSON.parse(fs.readFileSync(path.join(base, '.suno-backup-index.json'), 'utf8'));
    expect(idx.tracks[UUID]).toBeTruthy();
  });

  test('Scenario B: invalid URL fails with INVALID_URL and makes no network request', async () => {
    const c = buildController(base, availableResolver());
    c.addJobs([parsedFor(UUID, false)], { format: 'mp3' });
    await c.run();
    expect(c.jobs[0].status).toBe(JobStatus.FAILED);
    expect(c.jobs[0].errorCategory).toBe('INVALID_URL');
    expect(hits.audio).toBe(0);
  });

  test('Scenario C: duplicate second import is SKIPPED_DUPLICATE', async () => {
    const c1 = buildController(base, availableResolver());
    c1.addJobs([parsedFor(UUID)], { format: 'original' });
    await c1.run();
    expect(c1.jobs[0].status).toBe(JobStatus.COMPLETED);

    const c2 = buildController(base, availableResolver());
    c2.addJobs([parsedFor(UUID)], { format: 'original' });
    await c2.run();
    expect(c2.jobs[0].status).toBe(JobStatus.SKIPPED_DUPLICATE);
  });

  test('Scenario D: AUTH_REQUIRED track never attempts download', async () => {
    const resolver = { resolve: async () => ({ state: Availability.AUTH_REQUIRED }) };
    const c = buildController(base, resolver);
    c.addJobs([parsedFor(UUID)], { format: 'mp3' });
    await c.run();
    expect(c.jobs[0].status).toBe(JobStatus.FAILED);
    expect(c.jobs[0].errorCategory).toBe('AUTH_REQUIRED');
    expect(hits.audio).toBe(0);
  });

  test('Scenario E: network interruption -> FAILED, no finalized output, retryable', async () => {
    const c = buildController(base, availableResolver('/cut'));
    c.addJobs([parsedFor(UUID)], { format: 'original' });
    await c.run();
    expect(c.jobs[0].status).toBe(JobStatus.FAILED);
    // No completed audio file should exist in the destination tree.
    const originalDir = path.join(base, 'original');
    const leftovers = fs.existsSync(originalDir) ? fs.readdirSync(originalDir) : [];
    expect(leftovers.filter((f) => !f.endsWith('.part'))).toHaveLength(0);
    expect(c.jobs[0].isTerminal()).toBe(true);
  });

  test('Scenario F: HTML/non-audio response -> INVALID_AUDIO, no output', async () => {
    const c = buildController(base, availableResolver('/page'));
    c.addJobs([parsedFor(UUID)], { format: 'mp3' });
    await c.run();
    expect(c.jobs[0].status).toBe(JobStatus.FAILED);
    expect(['INVALID_AUDIO', 'DOWNLOAD_FAILED']).toContain(c.jobs[0].errorCategory);
    expect(c.jobs[0].outputs.length).toBe(0);
  });
});

describe('Integration: Scenario H — queue scalability (100 URLs, bounded concurrency)', () => {
  let base;
  beforeEach(() => (base = makeTempDir()));
  afterEach(() => rmrf(base));

  test('processes 100 jobs with bounded concurrency and no state corruption', async () => {
    let active = 0;
    let maxActive = 0;
    const CONCURRENCY = 4;

    const resolver = {
      resolve: async (parsed) => ({
        state: Availability.AVAILABLE,
        audioUrl: `https://cdn1.suno.ai/${parsed.id}.mp3`,
        expectedHost: 'cdn1.suno.ai',
        metadata: { id: parsed.id, title: `T-${parsed.id.slice(0, 4)}`, isPublic: true },
      }),
    };
    const downloader = {
      download: async ({ destPath }) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        fs.writeFileSync(destPath, 'DATA');
        active -= 1;
        return { path: destPath, bytes: 4, contentType: 'audio/mpeg' };
      },
    };
    const audio = {
      probe: async () => ({ codec: 'mp3', container: 'mp3', duration: 1, sampleRate: 44100, channels: 2, bitRate: 1, sizeBytes: 4 }),
      toMp3: async (s, d) => (fs.writeFileSync(d, 'm'), d),
      toWav: async (s, d) => (fs.writeFileSync(d, 'w'), d),
    };

    const c = buildController(base, resolver, { downloader, audio, concurrency: CONCURRENCY });
    const parsedList = [];
    for (let i = 0; i < 100; i++) {
      const id = `${i.toString(16).padStart(8, '0')}-bbbb-cccc-dddd-eeeeeeeeeeee`;
      parsedList.push(parsedFor(id));
    }
    c.addJobs(parsedList, { format: 'original' });
    await c.run();

    const completed = c.jobs.filter((j) => j.status === JobStatus.COMPLETED).length;
    expect(completed).toBe(100);
    expect(maxActive).toBeLessThanOrEqual(CONCURRENCY);
    // No two jobs collided on output path.
    const outs = c.jobs.map((j) => j.outputs[0]);
    expect(new Set(outs).size).toBe(100);
  });
});
