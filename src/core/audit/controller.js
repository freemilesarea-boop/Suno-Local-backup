'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const S = require('./schema');
const { hashFile, scanStrings, hexPreview } = require('./scan');
const { analyzeContainers } = require('./containers');
const { FfprobeMeta } = require('./ffmeta');
const { classifyText, analyzeRights, aggregateProvenance, runWatermarkRegistry } = require('./rules');

const PRIVATE_ID3 = new Set(['PRIV', 'UFID', 'TXXX', 'COMM', 'WXXX', 'APIC', 'GEOB', 'PCNT', 'MCDI']);

/**
 * ProvenanceAuditController — read-only orchestration of all analyzers.
 *
 * Every analyzer runs in isolation: if one throws, its failure becomes a
 * warning and the rest still run (AUDIT_PARTIAL). The audit NEVER writes to the
 * audited file and NEVER changes download status.
 */
class ProvenanceAuditController {
  constructor(deps = {}) {
    this.ffmeta = deps.ffmeta || new FfprobeMeta(deps);
    this.now = deps.now || (() => new Date().toISOString());
    this.limits = { maxStringHits: 400, maxBinaryEvidence: 60, maxHex: 8, maxStructured: 300 };
  }

  /**
   * @param {string} filePath
   * @param {object} [context] { source:{service,url,trackId,importedAt,originalFilename}, isOriginal, container, codec }
   */
  async audit(filePath, context = {}) {
    const warnings = [];
    const report = {
      schemaVersion: S.SCHEMA_VERSION,
      auditVersion: S.AUDIT_VERSION,
      generatedAt: this.now(),
      status: S.AuditStatus.RUNNING,
      file: { path: filePath, name: path.basename(filePath), ext: path.extname(filePath).replace('.', '').toLowerCase() },
      technical: {},
      provenance: {},
      rights: {},
      aiProvenance: {},
      watermark: {},
      metadata: { structured: [], private: [], unknown: [] },
      binaryEvidence: [],
      hexEvidence: [],
      warnings,
    };
    let anyOk = false;

    // 1. File identity + integrity (streaming SHA-256).
    try {
      const { sha256, size } = await hashFile(filePath);
      report.file.sha256 = sha256;
      report.file.size = size;
      anyOk = true;
    } catch (e) {
      warnings.push({ stage: 'identity', error: e.message });
    }

    // 2. Deep ffprobe metadata.
    let tags = {};
    try {
      const ff = await this.ffmeta.analyze(filePath);
      if (ff.ok) {
        report.technical = ff.technical;
        report.file.container = ff.technical.container;
        report.file.codec = ff.technical.codec;
        tags = ff.tags || {};
        anyOk = true;
      } else {
        warnings.push({ stage: 'ffprobe', error: ff.error });
      }
    } catch (e) {
      warnings.push({ stage: 'ffprobe', error: e.message });
    }

    const evidence = [];

    // structured tags -> classify
    const structEntries = Object.entries(tags).slice(0, this.limits.maxStructured);
    for (const [key, value] of structEntries) {
      const matches = classifyText(value, { structured: true, key });
      report.metadata.structured.push({ key, value, families: matches.map((m) => m.family) });
      evidence.push(...matches);
    }

    // 3. Container forensics (ID3 / RIFF).
    let privateDataCount = 0;
    try {
      const cont = await analyzeContainers(filePath, report.file.container || context.container);
      if (cont.id3 && cont.id3.present) {
        report.metadata.id3 = { versions: cont.id3.versions, frameCount: cont.id3.frames.length };
        for (const fr of cont.id3.frames) {
          if (fr.preview) evidence.push(...classifyText(fr.preview, { structured: true, key: fr.id }));
          if (PRIVATE_ID3.has(fr.id) || fr.hasBinary) {
            privateDataCount += 1;
            report.metadata.private.push({ kind: 'id3-frame', id: fr.id, size: fr.size, preview: fr.preview, hexPreview: fr.hexPreview });
          }
        }
        anyOk = true;
      }
      if (cont.riff && cont.riff.isRiff) {
        report.metadata.riff = { form: cont.riff.form, chunks: cont.riff.chunks };
        for (const info of cont.riff.info) {
          evidence.push(...classifyText(info.value, { structured: true, key: `${info.list}/${info.id}` }));
          report.metadata.structured.push({ key: `RIFF ${info.list}/${info.id}`, value: info.value, families: [] });
        }
        if (cont.riff.bext) {
          report.metadata.bext = cont.riff.bext;
          for (const [k, v] of Object.entries(cont.riff.bext)) evidence.push(...classifyText(v, { structured: true, key: `bext.${k}` }));
        }
        if (cont.riff.ixmlPreview) {
          report.metadata.ixmlPreview = cont.riff.ixmlPreview;
          evidence.push(...classifyText(cont.riff.ixmlPreview, { structured: true, key: 'iXML' }));
        }
        for (const u of cont.riff.unknown) {
          privateDataCount += 1;
          report.metadata.unknown.push({ kind: 'riff-chunk', fourCC: u.fourCC, offset: u.offset, size: u.size, preview: u.preview, hexPreview: u.hexPreview });
        }
        anyOk = true;
      }
    } catch (e) {
      warnings.push({ stage: 'containers', error: e.message });
    }

    // 4. Raw binary string scan.
    let stringHits = [];
    try {
      stringHits = await scanStrings(filePath, { maxHits: this.limits.maxStringHits });
      anyOk = true;
      for (const hit of stringHits) {
        const matches = classifyText(hit.text, { structured: false });
        if (matches.length) {
          const families = [...new Set(matches.map((m) => m.family))];
          const conf = matches.reduce((a, m) => (rank(m.confidence) > rank(a) ? m.confidence : a), S.Confidence.LOW);
          if (report.binaryEvidence.length < this.limits.maxBinaryEvidence) {
            report.binaryEvidence.push({ offset: hit.offset, encoding: hit.encoding, families, confidence: conf, text: hit.text });
          }
          evidence.push(...matches);
        }
      }
    } catch (e) {
      warnings.push({ stage: 'strings', error: e.message });
    }

    // 5. Hex evidence for the strongest binary hits.
    try {
      const top = [...report.binaryEvidence]
        .sort((a, b) => rank(b.confidence) - rank(a.confidence))
        .slice(0, this.limits.maxHex);
      for (const ev of top) {
        const hx = await hexPreview(filePath, ev.offset, { bytes: 48, pre: 8 });
        report.hexEvidence.push({ offset: ev.offset, offsetHex: '0x' + ev.offset.toString(16), hex: hx.hex, ascii: hx.ascii });
      }
    } catch (e) {
      warnings.push({ stage: 'hex', error: e.message });
    }

    // 6. Aggregate provenance / rights / watermark.
    const sourceService = context.source && context.source.service ? context.source.service : null;
    const provenanceEvidence = evidence.filter((e) =>
      [S.Family.SUNO, S.Family.AI, S.Family.MODEL, S.Family.PROVENANCE].includes(e.family)
    );

    report.rights = analyzeRights(evidence);
    report.aiProvenance = aggregateProvenance(evidence, sourceService);
    report.watermark = runWatermarkRegistry({ provenanceEvidence, privateDataCount });

    report.provenance = {
      source: sourceService || null,
      sourceUrl: context.source && context.source.url ? context.source.url : null,
      sourceTrackId: context.source && context.source.trackId ? context.source.trackId : null,
      importedAt: context.source && context.source.importedAt ? context.source.importedAt : null,
      isOriginal: context.isOriginal !== false,
      classification: report.aiProvenance.classification,
      // SOURCE_PROVENANCE is a distinct, honest signal from embedded evidence.
      sourceProvenance: sourceService ? sourceService.toUpperCase() : S.EvidenceStatus.UNKNOWN,
    };

    // 7. Status: independent of download; PARTIAL if any analyzer warned.
    if (!anyOk) report.status = S.AuditStatus.FAILED;
    else if (warnings.length) report.status = S.AuditStatus.PARTIAL;
    else report.status = S.AuditStatus.COMPLETE;

    return report;
  }
}

function rank(c) {
  return c === 'HIGH' ? 3 : c === 'MEDIUM' ? 2 : c === 'LOW' ? 1 : 0;
}

/** Write the <file>.audit.json sidecar atomically (never touches the audio). */
async function writeSidecar(report, sidecarPath) {
  await fsp.mkdir(path.dirname(sidecarPath), { recursive: true });
  const tmp = sidecarPath + '.part';
  await fsp.writeFile(tmp, JSON.stringify(report, null, 2));
  await fsp.rename(tmp, sidecarPath);
  return sidecarPath;
}

/** Compact, UI-friendly summary derived from a full report. */
function summarize(report) {
  return {
    status: report.status,
    sha256: report.file.sha256 || null,
    container: report.file.container || report.file.ext || null,
    codec: report.file.codec || null,
    sourceProvenance: report.provenance.sourceProvenance || 'UNKNOWN',
    aiClassification: report.aiProvenance.classification,
    sunoEvidenceCount: (report.binaryEvidence || []).filter((e) => e.families.includes('SUNO')).length
      + (report.metadata.structured || []).filter((m) => m.families.includes('SUNO')).length,
    metadataCount: (report.metadata.structured || []).length,
    binaryEvidenceCount: (report.binaryEvidence || []).length,
    privateUnknownCount: (report.metadata.private || []).length + (report.metadata.unknown || []).length,
    watermarkStatus: report.watermark.status,
    rightsStatus: report.rights.status,
    warnings: report.warnings.length,
  };
}

/** Bounded, UI-friendly detail derived from a full report (safe to send over IPC). */
function auditDetail(report) {
  return {
    sha256: report.file.sha256 || null,
    container: report.file.container || report.file.ext || null,
    codec: report.file.codec || null,
    technical: {
      sampleRate: report.technical.sampleRate || null,
      channels: report.technical.channels || null,
      duration: report.technical.duration || null,
      bitRate: report.technical.bitRate || null,
    },
    aiProvenance: {
      classification: report.aiProvenance.classification,
      score: report.aiProvenance.score,
      evidence: (report.aiProvenance.evidence || []).slice(0, 15),
    },
    watermark: {
      status: report.watermark.status,
      detectors: (report.watermark.detectors || []).map((d) => ({ name: d.name, status: d.status, limitations: d.limitations })),
      limitations: report.watermark.limitations || [],
    },
    rights: {
      status: report.rights.status,
      evidence: (report.rights.evidence || []).slice(0, 10),
      limitations: report.rights.limitations || [],
    },
    sunoEvidence: (report.binaryEvidence || []).filter((e) => e.families.includes('SUNO')).slice(0, 15),
    structured: (report.metadata.structured || []).slice(0, 30),
    binaryEvidence: (report.binaryEvidence || []).slice(0, 25),
    hexEvidence: (report.hexEvidence || []).slice(0, 8),
    privateUnknown: [...(report.metadata.private || []), ...(report.metadata.unknown || [])].slice(0, 15),
    warnings: report.warnings || [],
  };
}

module.exports = { ProvenanceAuditController, writeSidecar, summarize, auditDetail };

