'use strict';

/* global window, document */

// The only bridge to the main process. No Node APIs are available here.
const api = window.suno;

const els = {
  urls: document.getElementById('urls'),
  urlSummary: document.getElementById('url-summary'),
  chooseFolder: document.getElementById('choose-folder'),
  destPath: document.getElementById('dest-path'),
  start: document.getElementById('start'),
  retry: document.getElementById('retry'),
  globalStatus: document.getElementById('global-status'),
  queue: document.getElementById('queue'),
  queueEmpty: document.getElementById('queue-empty'),
};

const state = {
  destDir: null,
  jobs: new Map(), // id -> snapshot
  running: false,
};

function selectedFormat() {
  const checked = document.querySelector('input[name="format"]:checked');
  return checked ? checked.value : 'original';
}

function updateStartEnabled() {
  const hasText = els.urls.value.trim().length > 0;
  els.start.disabled = state.running || !hasText || !state.destDir;
}

async function refreshUrlSummary() {
  const text = els.urls.value;
  if (!text.trim()) {
    els.urlSummary.textContent = '';
    updateStartEnabled();
    return;
  }
  const { valid, invalid } = await api.parseUrls(text);
  let msg = `${valid.length} valid URL${valid.length === 1 ? '' : 's'}`;
  if (invalid.length) {
    msg += ` · <span class="bad">${invalid.length} ignored</span>`;
  }
  els.urlSummary.innerHTML = msg;
  updateStartEnabled();
}

async function chooseFolder() {
  const res = await api.selectFolder();
  if (res && !res.canceled && res.path) {
    state.destDir = res.path;
    els.destPath.textContent = res.path;
    els.destPath.title = res.path;
  }
  updateStartEnabled();
}

function jobRowId(id) {
  return `job-row-${id}`;
}

function renderJob(snapshot) {
  state.jobs.set(snapshot.id, snapshot);
  els.queueEmpty.style.display = 'none';

  let row = document.getElementById(jobRowId(snapshot.id));
  if (!row) {
    row = document.createElement('li');
    row.id = jobRowId(snapshot.id);
    row.className = 'job';
    els.queue.appendChild(row);
  }

  const title = snapshot.title || snapshot.trackId || snapshot.url;
  const showProgress =
    ['DOWNLOADING', 'CONVERTING', 'RESOLVING', 'VERIFYING', 'SAVING', 'VALIDATING'].includes(
      snapshot.status
    );
  const determinate = typeof snapshot.progress === 'number';
  const pct = determinate ? Math.round(snapshot.progress * 100) : 0;

  row.innerHTML = `
    <div>
      <div class="title"></div>
      <div class="meta"></div>
    </div>
    <div class="status ${snapshot.status}">${statusLabel(snapshot)}</div>
    ${
      showProgress
        ? `<div class="progress-track"><div class="progress-bar ${
            determinate ? '' : 'indeterminate'
          }" style="${determinate ? `width:${pct}%` : ''}"></div></div>`
        : ''
    }
    ${snapshot.errorMessage ? `<div class="error"></div>` : ''}
  `;
  // Assign text via textContent to avoid any HTML injection from metadata.
  row.querySelector('.title').textContent = title;
  row.querySelector('.meta').textContent = `${snapshot.format} · ${snapshot.url}`;
  if (snapshot.errorMessage) row.querySelector('.error').textContent = snapshot.errorMessage;
}

function statusLabel(s) {
  if (s.status === 'DOWNLOADING' && typeof s.progress !== 'number') return 'Downloading…';
  if (s.status === 'SKIPPED_DUPLICATE') return 'Duplicate';
  return s.status.replace(/_/g, ' ').toLowerCase();
}

function summarizeBatch() {
  const jobs = [...state.jobs.values()];
  const done = jobs.filter((j) => j.status === 'COMPLETED').length;
  const failed = jobs.filter((j) => j.status === 'FAILED').length;
  const dup = jobs.filter((j) => j.status === 'SKIPPED_DUPLICATE').length;
  els.globalStatus.textContent = `${done} completed · ${failed} failed · ${dup} duplicate`;
  els.retry.disabled = state.running || failed === 0;
}

async function startImport() {
  if (state.running) return;
  state.running = true;
  updateStartEnabled();
  els.retry.disabled = true;
  els.globalStatus.textContent = 'Working…';

  const res = await api.startImport({
    text: els.urls.value,
    format: selectedFormat(),
    destDir: state.destDir,
  });

  state.running = false;
  if (!res || !res.ok) {
    els.globalStatus.textContent = (res && res.error) || 'Import failed to start.';
  } else {
    for (const snap of res.jobs) renderJob(snap);
    summarizeBatch();
  }
  updateStartEnabled();
}

async function retryFailed() {
  if (state.running) return;
  state.running = true;
  els.retry.disabled = true;
  updateStartEnabled();
  els.globalStatus.textContent = 'Retrying…';
  const res = await api.retryFailed();
  state.running = false;
  if (res && res.ok) {
    for (const snap of res.jobs) renderJob(snap);
    summarizeBatch();
  } else {
    els.globalStatus.textContent = (res && res.error) || 'Retry failed.';
  }
  updateStartEnabled();
}

// Wire up events.
els.urls.addEventListener('input', debounce(refreshUrlSummary, 200));
els.chooseFolder.addEventListener('click', chooseFolder);
els.start.addEventListener('click', startImport);
els.retry.addEventListener('click', retryFailed);

api.onJobUpdate((snapshot) => {
  renderJob(snapshot);
  summarizeBatch();
});

// Restore last destination folder if available.
(async () => {
  const last = await api.getLastDir();
  if (last) {
    state.destDir = last;
    els.destPath.textContent = last;
    els.destPath.title = last;
  }
  updateStartEnabled();
})();

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
