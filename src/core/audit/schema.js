'use strict';

/**
 * Shared vocabulary for the read-only Audio Provenance & Rights Audit engine.
 *
 * The status systems here are deliberately strict: NOT_DETECTED never means
 * "absent" for a proprietary/undocumented marker, and a commercial license is
 * never "confirmed" from the file alone. See CRITICAL TRUTHFULNESS RULE.
 */

const SCHEMA_VERSION = '1.0.0';
const AUDIT_VERSION = '1.0.0';

// Overall audit lifecycle / result (independent of download status).
const AuditStatus = Object.freeze({
  PENDING: 'AUDIT_PENDING',
  RUNNING: 'AUDIT_RUNNING',
  COMPLETE: 'AUDIT_COMPLETE',
  PARTIAL: 'AUDIT_PARTIAL',
  FAILED: 'AUDIT_FAILED',
  UNSUPPORTED: 'AUDIT_UNSUPPORTED',
  CANCELLED: 'AUDIT_CANCELLED',
});

// Generic detection state for any evidence/marker.
const EvidenceStatus = Object.freeze({
  DETECTED: 'DETECTED',
  SUSPECTED: 'SUSPECTED',
  NOT_DETECTED: 'NOT_DETECTED',
  UNKNOWN: 'UNKNOWN',
  UNSUPPORTED: 'UNSUPPORTED',
  ERROR: 'ERROR',
});

// Commercial-rights evaluation — separate from anything in the audio bytes.
const RightsStatus = Object.freeze({
  CONFIRMED_BY_EVIDENCE: 'CONFIRMED_BY_EVIDENCE',
  USER_DECLARED: 'USER_DECLARED',
  CONFLICTING_EVIDENCE: 'CONFLICTING_EVIDENCE',
  UNKNOWN: 'UNKNOWN',
  NOT_EVALUATED: 'NOT_EVALUATED',
});

// AI-provenance evidence aggregation (NOT a probability, NOT a legal finding).
const AIProvenance = Object.freeze({
  STRONG_EVIDENCE: 'STRONG_EVIDENCE',
  MODERATE_EVIDENCE: 'MODERATE_EVIDENCE',
  WEAK_EVIDENCE: 'WEAK_EVIDENCE',
  NO_EVIDENCE_FOUND: 'NO_EVIDENCE_FOUND',
  UNKNOWN: 'UNKNOWN',
});

const Confidence = Object.freeze({ HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW' });

// Where a single piece of evidence came from — never conflated across kinds.
const EvidenceSource = Object.freeze({
  SOURCE_METADATA: 'SOURCE_METADATA', // the app imported it from a known service
  FILE_METADATA: 'FILE_METADATA', // structured container/tag field
  CONTAINER_CHUNK: 'CONTAINER_CHUNK', // RIFF chunk / ID3 frame presence
  RAW_STRING: 'RAW_STRING', // printable bytes found by the scanner
  SIGNAL_FEATURE: 'SIGNAL_FEATURE', // audio statistics (never a watermark claim)
  USER_INPUT: 'USER_INPUT',
  EXTERNAL_VERIFICATION: 'EXTERNAL_VERIFICATION',
});

// Family a keyword hit belongs to.
const Family = Object.freeze({
  SUNO: 'SUNO',
  AI: 'AI',
  MODEL: 'MODEL',
  RIGHTS: 'RIGHTS',
  PROVENANCE: 'PROVENANCE',
});

module.exports = {
  SCHEMA_VERSION,
  AUDIT_VERSION,
  AuditStatus,
  EvidenceStatus,
  RightsStatus,
  AIProvenance,
  Confidence,
  EvidenceSource,
  Family,
};
