'use strict';

const { ProvenanceAuditController, writeSidecar, summarize, auditDetail } = require('./controller');

/** Build a ready-to-use auditor (uses the bundled ffprobe). */
function createAuditor(deps = {}) {
  return new ProvenanceAuditController(deps);
}

module.exports = { createAuditor, ProvenanceAuditController, writeSidecar, summarize, auditDetail };
