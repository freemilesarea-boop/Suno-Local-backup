'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

/**
 * Metadata Manager.
 *
 * Persists per-track metadata as a sidecar JSON next to the audio file, and
 * maintains a lightweight JSON index in the destination folder used for
 * duplicate detection by canonical Suno track id (Layer 1). No new database /
 * persistence framework is introduced — a single JSON index file is enough.
 */

const INDEX_FILE = '.suno-backup-index.json';

class MetadataManager {
  /**
   * @param {object} opts
   * @param {string} opts.baseDir
   * @param {string} [opts.indexFileName]
   */
  constructor(opts = {}) {
    if (!opts.baseDir) throw new Error('MetadataManager requires baseDir');
    this.baseDir = path.resolve(opts.baseDir);
    this.indexPath = path.join(this.baseDir, opts.indexFileName || INDEX_FILE);
    this._index = null;
    this._writeChain = Promise.resolve(); // serialize index mutations
  }

  async _loadIndex() {
    if (this._index) return this._index;
    try {
      const txt = await fsp.readFile(this.indexPath, 'utf8');
      const parsed = JSON.parse(txt);
      this._index = parsed && typeof parsed === 'object' && parsed.tracks ? parsed : { version: 1, tracks: {} };
    } catch {
      this._index = { version: 1, tracks: {} };
    }
    return this._index;
  }

  async _saveIndex() {
    await fsp.mkdir(this.baseDir, { recursive: true });
    const tmp = this.indexPath + '.part';
    await fsp.writeFile(tmp, JSON.stringify(this._index, null, 2));
    await fsp.rename(tmp, this.indexPath);
  }

  /** Layer 1 duplicate check by track id. */
  async hasTrack(id) {
    if (!id) return false;
    const idx = await this._loadIndex();
    return Object.prototype.hasOwnProperty.call(idx.tracks, id);
  }

  async getTrack(id) {
    const idx = await this._loadIndex();
    return idx.tracks[id] || null;
  }

  /**
   * Record a completed import: update the index and write a sidecar file.
   * @param {object} record - see fields below
   * @param {string} record.id
   * @param {string} [record.url]
   * @param {string} [record.title]
   * @param {string} [record.createdAt]
   * @param {string} [record.importedAt]
   * @param {string} [record.sourceFormat]
   * @param {string[]} [record.outputs] - relative paths of produced files
   * @param {object} [record.audio] - {duration, sampleRate, channels, codec, container}
   * @param {string} sidecarPath - absolute path for the `.json` sidecar
   */
  async record(record, sidecarPath) {
    if (!record || !record.id) throw new Error('record requires an id');
    // Serialize the read-modify-write of the shared index file.
    this._writeChain = this._writeChain.then(async () => {
      const idx = await this._loadIndex();
      idx.tracks[record.id] = {
        id: record.id,
        url: record.url,
        title: record.title,
        importedAt: record.importedAt,
        outputs: record.outputs || [],
      };
      await this._saveIndex();
    });
    await this._writeChain;

    if (sidecarPath) {
      await fsp.mkdir(path.dirname(sidecarPath), { recursive: true });
      const tmp = sidecarPath + '.part';
      await fsp.writeFile(tmp, JSON.stringify(record, null, 2));
      await fsp.rename(tmp, sidecarPath);
    }
    return record;
  }
}

module.exports = { MetadataManager, INDEX_FILE };
