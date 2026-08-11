'use strict';

const fs = require('fs');
const path = require('path');

const { hashFile, scanStrings, hexPreview, redactEvidence } = require('../src/core/audit/scan');
const { parseId3, parseRiff, analyzeContainers } = require('../src/core/audit/containers');
const { classifyText, analyzeRights, aggregateProvenance, runWatermarkRegistry } = require('../src/core/audit/rules');
const { createAuditor, writeSidecar, summarize } = require('../src/core/audit');
const { ProvenanceAuditController } = require('../src/core/audit/controller');
const { RightsStatus, AIProvenance, EvidenceStatus, AuditStatus } = require('../src/core/audit/schema');
const { ImportController } = require('../src/core/import-controller');
const { StorageManager } = require('../src/core/storage');
const { MetadataManager } = require('../src/core/metadata');
const { Availability } = require('../src/core/resolver');
const { JobStatus } = require('../src/core/job');
const { makeAuditFixtures } = require('./helpers/audit-fixtures');
const { makeTempDir, rmrf } = require('./helpers/fixtures');

let dir;
let fx;
beforeAll(() => {
  dir = makeTempDir('audit-');
  fx = makeAuditFixtures(dir);
});
afterAll(() => rmrf(dir));

describe('File identity + integrity', () => {
  test('T100 SHA-256 is stable across runs', async () => {
    const a = await hashFile(fx.wavClean);
    const b = await hashFile(fx.wavClean);
    expect(a.sha256).toBe(b.sha256);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.size).toBe(b.size);
  });

  test('T101 audit never mutates the original file', async () => {
    const before = await hashFile(fx.mp3Rich);
    const auditor = createAuditor({ now: () => 'T' });
    await auditor.audit(fx.mp3Rich, { source: { service: 'Suno' } });
    const after = await hashFile(fx.mp3Rich);
    expect(after.sha256).toBe(before.sha256);
  });
});

describe('MP3 ID3 forensics', () => {
  let id3;
  beforeAll(() => {
    const buf = fs.readFileSync(fx.mp3Rich);
    id3 = parseId3(fx.mp3Rich, buf);
  });
  test('T102 ID3 frames enumerated', () => {
    expect(id3.present).toBe(true);
    expect(id3.versions).toContain('ID3v2.4');
    const ids = id3.frames.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(['TIT2', 'TPE1', 'TENC']));
  });
  test('T103 custom TXXX frame detected with preview', () => {
    const txxx = id3.frames.find((f) => f.id === 'TXXX');
    expect(txxx).toBeTruthy();
    expect(txxx.preview.toLowerCase()).toContain('suno');
  });
  test('T104 PRIV frame detected and flagged binary', () => {
    const priv = id3.frames.find((f) => f.id === 'PRIV');
    expect(priv).toBeTruthy();
    expect(priv.hasBinary).toBe(true);
    expect(priv.hexPreview.length).toBeGreaterThan(0);
  });
});

describe('WAV / RIFF forensics', () => {
  test('T105 LIST/INFO chunk detected', () => {
    const r = parseRiff(fs.readFileSync(fx.wavInfo));
    expect(r.isRiff).toBe(true);
    expect(r.info.length).toBeGreaterThan(0);
    expect(r.info.map((i) => i.id)).toContain('ISFT');
  });
  test('T106 BEXT chunk detected', () => {
    const r = parseRiff(fs.readFileSync(fx.wavBext));
    expect(r.bext).toBeTruthy();
    expect(r.bext.originator.toLowerCase()).toContain('suno');
  });
  test('T107 iXML chunk detected', () => {
    const r = parseRiff(fs.readFileSync(fx.wavIxml));
    expect(r.ixmlPreview).toBeTruthy();
    expect(r.ixmlPreview).toContain('BWFXML');
  });
  test('T108 unknown RIFF chunk reported (not dropped)', () => {
    const r = parseRiff(fs.readFileSync(fx.wavUnknown));
    expect(r.unknown.map((u) => u.fourCC)).toContain('XyZq');
  });
});

describe('Keyword / provenance classification', () => {
  test('T109 Suno structured metadata classified HIGH', () => {
    const m = classifyText('Suno', { structured: true, key: 'encoder' });
    const suno = m.find((x) => x.family === 'SUNO');
    expect(suno).toBeTruthy();
    expect(suno.confidence).toBe('HIGH');
  });

  test('T110 suno.com binary string detected with correct offset', async () => {
    const hits = await scanStrings(fx.binSuno, { minLen: 4 });
    const hit = hits.find((h) => /suno\.ai/i.test(h.text));
    expect(hit).toBeTruthy();
    expect(hit.offset).toBe(fx.binSunoOffset);
    expect(classifyText(hit.text).some((m) => m.family === 'SUNO')).toBe(true);
  });

  test('T111 raw "AI" coincidence does NOT cause strong/moderate classification', () => {
    const m = classifyText('note AI here'); // bare AI, LOW, bareAI=true
    expect(m.some((x) => x.bareAI)).toBe(true);
    const agg = aggregateProvenance(m, null);
    expect([AIProvenance.NO_EVIDENCE_FOUND, AIProvenance.WEAK_EVIDENCE]).toContain(agg.classification);
    expect(agg.classification).not.toBe(AIProvenance.STRONG_EVIDENCE);
    expect(agg.classification).not.toBe(AIProvenance.MODERATE_EVIDENCE);
    expect(agg.score).toBe(0); // bare AI never scores
  });
});

describe('Rights / commercial-use evidence', () => {
  test('T112 commercial keyword detected', () => {
    expect(classifyText('licensed for commercial use').some((m) => m.rights === 'commercial')).toBe(true);
  });
  test('T113 non-commercial keyword detected', () => {
    expect(classifyText('non-commercial personal use only').some((m) => m.rights === 'noncommercial')).toBe(true);
  });
  test('T114 conflicting rights evidence -> CONFLICTING_EVIDENCE', () => {
    const ev = [...classifyText('commercial use'), ...classifyText('non-commercial')];
    expect(analyzeRights(ev).status).toBe(RightsStatus.CONFLICTING_EVIDENCE);
  });
  test('T115 no rights evidence -> UNKNOWN', () => {
    expect(analyzeRights([]).status).toBe(RightsStatus.UNKNOWN);
  });
});

describe('Redaction + hex + memory', () => {
  test('T116 URL secrets are redacted in evidence + scanner output', async () => {
    expect(redactEvidence('https://cdn1.suno.ai/x.mp3?token=SECRET123&Signature=ABCXYZ')).not.toContain('SECRET123');
    const hits = await scanStrings(fx.binSecret, {});
    const joined = hits.map((h) => h.text).join(' ');
    expect(joined).not.toContain('SECRET123');
    expect(joined).not.toContain('ABCXYZ');
    expect(joined).toContain('cdn1.suno.ai'); // host kept, secret stripped
  });

  test('hex preview returns bounded hex + ascii around an offset', async () => {
    const hx = await hexPreview(fx.binSuno, fx.binSunoOffset, { bytes: 32, pre: 0 });
    expect(hx.ascii).toMatch(/https/);
    expect(hx.hex.split(' ').length).toBeLessThanOrEqual(32);
  });

  test('T117 large-file scanning stays bounded and still finds the marker', async () => {
    const big = path.join(dir, 'big.bin');
    const fd = fs.openSync(big, 'w');
    const filler = Buffer.alloc(512 * 1024, 0x00);
    for (let i = 0; i < 8; i++) fs.writeSync(fd, filler); // ~4 MB
    fs.writeSync(fd, Buffer.from('marker https://cdn1.suno.ai/late.mp3'));
    fs.closeSync(fd);
    const hits = await scanStrings(big, { maxHits: 50 });
    expect(hits.length).toBeLessThanOrEqual(50);
    expect(hits.some((h) => /suno\.ai/i.test(h.text))).toBe(true);
  });
});

describe('Watermark registry honesty', () => {
  test('T119 unknown/private data is NOT called a watermark', () => {
    const wm = runWatermarkRegistry({ provenanceEvidence: [], privateDataCount: 3 });
    expect(wm.status).toBe(EvidenceStatus.UNKNOWN);
    const priv = wm.detectors.find((d) => d.id === 'container-private-field');
    expect(priv.status).toBe(EvidenceStatus.DETECTED); // it found private data...
    // ...but the overall watermark verdict stays UNKNOWN, never DETECTED.
    expect(wm.status).not.toBe(EvidenceStatus.DETECTED);
  });
  test('T120 unsupported invisible-watermark detector returns UNSUPPORTED, overall UNKNOWN', () => {
    const wm = runWatermarkRegistry({ provenanceEvidence: [], privateDataCount: 0 });
    const suno = wm.detectors.find((d) => d.id === 'suno-invisible-watermark');
    expect(suno.status).toBe(EvidenceStatus.UNSUPPORTED);
    expect(wm.status).toBe(EvidenceStatus.UNKNOWN);
    expect(wm.limitations.join(' ')).toMatch(/does NOT mean a watermark is absent/i);
  });
});

describe('Full audit report', () => {
  test('T121 an analyzer error does not crash the audit (missing file)', async () => {
    const auditor = createAuditor({ now: () => 'T' });
    const r = await auditor.audit(path.join(dir, 'does-not-exist.mp3'), {});
    expect([AuditStatus.FAILED, AuditStatus.PARTIAL]).toContain(r.status);
    expect(Array.isArray(r.warnings)).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  test('T122 source provenance Suno recorded', async () => {
    const auditor = createAuditor({ now: () => 'T' });
    const r = await auditor.audit(fx.mp3Rich, { source: { service: 'Suno', url: 'https://suno.com/song/x', trackId: 'x' } });
    expect(r.provenance.sourceProvenance).toBe('SUNO');
    expect(r.provenance.sourceTrackId).toBe('x');
  });

  test('T124 JSON sidecar is written and schema-valid', async () => {
    const auditor = createAuditor({ now: () => 'T' });
    const r = await auditor.audit(fx.mp3Rich, { source: { service: 'Suno' } });
    const p = path.join(dir, 'rich.mp3.audit.json');
    await writeSidecar(r, p);
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const k of ['schemaVersion', 'auditVersion', 'file', 'provenance', 'rights', 'metadata', 'binaryEvidence', 'watermark', 'aiProvenance', 'warnings']) {
      expect(parsed).toHaveProperty(k);
    }
    expect(parsed.file.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('T125 report contains explicit limitations', async () => {
    const auditor = createAuditor({ now: () => 'T' });
    const r = await auditor.audit(fx.mp3Rich, { source: { service: 'Suno' } });
    expect(r.watermark.limitations.length).toBeGreaterThan(0);
    expect(r.rights.limitations.length).toBeGreaterThan(0);
  });

  test('rich MP3 audit surfaces Suno + AI evidence with correct kinds', async () => {
    const auditor = createAuditor({ now: () => 'T' });
    const r = await auditor.audit(fx.mp3Rich, { source: { service: 'Suno', url: 'https://suno.com/song/x' } });
    const s = summarize(r);
    expect(s.sunoEvidenceCount).toBeGreaterThan(0);
    expect([AIProvenance.STRONG_EVIDENCE, AIProvenance.MODERATE_EVIDENCE]).toContain(r.aiProvenance.classification);
    expect(r.watermark.status).toBe(EvidenceStatus.UNKNOWN); // never overclaimed
    expect(r.provenance.sourceProvenance).toBe('SUNO');
  });
});

describe('Pipeline integration (audit is independent of download)', () => {
  const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  function parsedFor(id) {
    return { ok: true, id, kind: 'song', canonicalUrl: `https://suno.com/song/${id}`, originalUrl: `https://suno.com/song/${id}` };
  }
  function build(base, auditor) {
    const resolver = {
      resolve: async () => ({ state: Availability.AVAILABLE, audioUrl: `https://cdn1.suno.ai/${UUID}.mp3`, expectedHost: 'cdn1.suno.ai', metadata: { id: UUID, title: 'Song', isPublic: true } }),
    };
    const downloader = { download: async ({ destPath }) => { fs.writeFileSync(destPath, 'FAKEAUDIO'); return { path: destPath, bytes: 9 }; } };
    const audio = {
      probe: async () => ({ codec: 'mp3', container: 'mp3', duration: 1, sampleRate: 44100, channels: 2, bitRate: 1, sizeBytes: 9 }),
      toMp3: async (s, d) => (fs.writeFileSync(d, 'm'), d),
      toWav: async (s, d) => (fs.writeFileSync(d, 'w'), d),
    };
    return new ImportController({
      adapter: {}, resolver, downloader, audio,
      storage: new StorageManager({ baseDir: base }), metadata: new MetadataManager({ baseDir: base }),
      auditor, logger: { info() {}, warn() {}, error() {} }, tmpDir: path.join(base, '.tmp'),
    });
  }

  test('T118 each produced output is audited separately', async () => {
    const base = makeTempDir('auditpipe-');
    const c = build(base, createAuditor({ now: () => 'T' }));
    c.addJobs([parsedFor(UUID)], { format: 'mp3+wav' });
    await c.run();
    const job = c.jobs[0];
    expect(job.status).toBe(JobStatus.COMPLETED);
    expect(job.audit).toBeTruthy();
    expect(job.audit.files.length).toBe(2);
    const shas = job.audit.files.map((f) => f.summary.sha256);
    expect(new Set(shas).size).toBe(2); // distinct files audited independently
    rmrf(base);
  });

  test('T123 an audit failure does NOT change the COMPLETED download', async () => {
    const base = makeTempDir('auditfail-');
    const throwingAuditor = { audit: async () => { throw new Error('boom'); } };
    const c = build(base, throwingAuditor);
    c.addJobs([parsedFor(UUID)], { format: 'mp3' });
    await c.run();
    const job = c.jobs[0];
    expect(job.status).toBe(JobStatus.COMPLETED); // download stays completed
    expect(job.audit && job.audit.status).toBe('AUDIT_FAILED');
    rmrf(base);
  });
});
