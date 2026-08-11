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
  version: document.getElementById('app-version'),
};

const state = {
  destDir: null,
  jobs: new Map(), // id -> snapshot
  running: false,
};

// Korean labels for job status (text is shown alongside color — never color alone).
const KO_STATUS = {
  QUEUED: '대기',
  VALIDATING: '확인 중',
  RESOLVING: '주소 확인 중',
  DOWNLOADING: '다운로드 중',
  VERIFYING: '검증 중',
  CONVERTING: '변환 중',
  SAVING: '저장 중',
  COMPLETED: '완료',
  FAILED: '실패',
  SKIPPED_DUPLICATE: '중복',
  CANCELLED: '취소됨',
};

// Korean, user-friendly messages keyed by the backend error category. The
// backend error codes/semantics are unchanged; this only localizes display.
const KO_ERROR = {
  INVALID_URL: '올바른 Suno 곡 URL을 입력해주세요.',
  TRACK_NOT_FOUND: '해당 곡을 찾을 수 없습니다.',
  AUTH_REQUIRED: '이 곡은 로그인한 사용자만 접근할 수 있습니다.',
  SOURCE_NOT_AVAILABLE: '이 곡에서 다운로드 가능한 오디오를 찾지 못했습니다.',
  NETWORK_ERROR: '네트워크 연결을 확인한 후 다시 시도해주세요.',
  DOWNLOAD_FAILED: '다운로드를 완료하지 못했습니다.',
  INVALID_AUDIO: '다운로드한 파일이 올바른 오디오가 아닙니다.',
  CONVERSION_FAILED: '오디오 변환에 실패했습니다.',
  STORAGE_ERROR: '선택한 폴더에 파일을 저장하지 못했습니다.',
  DUPLICATE: '이미 가져온 곡입니다.',
  UNSUPPORTED: '지원하지 않는 링크입니다.',
  POLICY_BLOCKED: '접근 제한으로 이 곡을 가져올 수 없습니다.',
  INTERNAL_ERROR: '예상치 못한 오류가 발생했습니다.',
};

const PROCESSING = ['VALIDATING', 'RESOLVING', 'DOWNLOADING', 'VERIFYING', 'CONVERTING', 'SAVING'];

function statusClass(status) {
  if (status === 'COMPLETED') return 'completed';
  if (status === 'FAILED') return 'failed';
  if (status === 'SKIPPED_DUPLICATE') return 'duplicate';
  if (status === 'QUEUED') return 'queued';
  return 'processing';
}

function statusLabel(s) {
  if (s.status === 'DOWNLOADING' && typeof s.progress !== 'number') return '다운로드 중…';
  return KO_STATUS[s.status] || s.status;
}

function baseName(p) {
  return String(p || '').split(/[\\/]/).pop();
}

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
  els.urlSummary.replaceChildren();
  if (!text.trim()) {
    updateStartEnabled();
    return;
  }
  const { valid, invalid } = await api.parseUrls(text);
  const ok = document.createElement('span');
  ok.className = 'badge ok';
  ok.textContent = `유효한 URL ${valid.length}개`;
  els.urlSummary.appendChild(ok);
  if (invalid.length) {
    const bad = document.createElement('span');
    bad.className = 'badge bad';
    bad.textContent = `무시됨 ${invalid.length}개`;
    els.urlSummary.appendChild(bad);
  }
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
  els.queueEmpty.classList.add('hidden');

  let row = document.getElementById(jobRowId(snapshot.id));
  if (!row) {
    row = document.createElement('li');
    row.id = jobRowId(snapshot.id);
    row.className = 'job';
    els.queue.appendChild(row);
  }
  row.replaceChildren();

  const title = snapshot.title || snapshot.trackId || snapshot.url;

  const main = document.createElement('div');
  main.className = 'job-main';
  const titleEl = document.createElement('div');
  titleEl.className = 'job-title';
  titleEl.textContent = title;
  const sub = document.createElement('div');
  sub.className = 'job-sub';
  sub.textContent = `${snapshot.format} · ${snapshot.url}`;
  main.append(titleEl, sub);

  // Completed: show output filenames + a "Finder에서 보기" button.
  if (snapshot.status === 'COMPLETED' && snapshot.outputs && snapshot.outputs.length) {
    const outs = document.createElement('div');
    outs.className = 'job-outputs';
    const files = document.createElement('span');
    files.className = 'files';
    files.textContent = snapshot.outputs.map(baseName).join(', ');
    outs.appendChild(files);
    if (api.revealPath) {
      const reveal = document.createElement('button');
      reveal.type = 'button';
      reveal.className = 'btn link';
      reveal.textContent = 'Finder에서 보기';
      reveal.addEventListener('click', () => api.revealPath(snapshot.outputs[0]));
      outs.appendChild(reveal);
    }
    main.appendChild(outs);
  }

  // Failed: friendly Korean message (falls back to backend message).
  if (snapshot.status === 'FAILED') {
    const err = document.createElement('div');
    err.className = 'job-error';
    err.textContent = KO_ERROR[snapshot.errorCategory] || snapshot.errorMessage || '오류가 발생했습니다.';
    main.appendChild(err);
  }

  const pill = document.createElement('div');
  pill.className = `status-pill ${statusClass(snapshot.status)}`;
  pill.textContent = statusLabel(snapshot);

  row.append(main, pill);

  // Progress bar for in-progress jobs. Width is set via CSSOM (allowed by CSP);
  // no inline style attribute is ever written into markup.
  if (PROCESSING.includes(snapshot.status)) {
    const track = document.createElement('div');
    track.className = 'progress-track';
    const bar = document.createElement('div');
    const determinate = typeof snapshot.progress === 'number';
    bar.className = 'progress-bar' + (determinate ? '' : ' indeterminate');
    if (determinate) bar.style.width = `${Math.round(snapshot.progress * 100)}%`;
    track.appendChild(bar);
    row.appendChild(track);
  }
}

function pill(label, cls) {
  const p = document.createElement('span');
  p.className = `pill ${cls}`;
  p.textContent = label;
  return p;
}

function summarizeBatch() {
  const jobs = [...state.jobs.values()];
  const done = jobs.filter((j) => j.status === 'COMPLETED').length;
  const failed = jobs.filter((j) => j.status === 'FAILED').length;
  const dup = jobs.filter((j) => j.status === 'SKIPPED_DUPLICATE').length;
  els.globalStatus.replaceChildren();
  if (state.running) els.globalStatus.appendChild(pill('처리 중…', 'busy'));
  els.globalStatus.appendChild(pill(`완료 ${done}`, 'ok'));
  els.globalStatus.appendChild(pill(`실패 ${failed}`, 'err'));
  els.globalStatus.appendChild(pill(`중복 ${dup}`, 'dup'));
  els.retry.disabled = state.running || failed === 0;
}

function setStatusMessage(text) {
  els.globalStatus.replaceChildren();
  const span = document.createElement('span');
  span.textContent = text;
  els.globalStatus.appendChild(span);
}

async function startImport() {
  if (state.running) return;
  state.running = true;
  updateStartEnabled();
  els.retry.disabled = true;
  setStatusMessage('처리 중…');

  const res = await api.startImport({
    text: els.urls.value,
    format: selectedFormat(),
    destDir: state.destDir,
  });

  state.running = false;
  if (!res || !res.ok) {
    setStatusMessage((res && res.error) || '가져오기를 시작하지 못했습니다.');
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
  setStatusMessage('다시 시도 중…');
  const res = await api.retryFailed();
  state.running = false;
  if (res && res.ok) {
    for (const snap of res.jobs) renderJob(snap);
    summarizeBatch();
  } else {
    setStatusMessage((res && res.error) || '다시 시도에 실패했습니다.');
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

// Restore last destination folder + app version.
(async () => {
  const last = await api.getLastDir();
  if (last) {
    state.destDir = last;
    els.destPath.textContent = last;
    els.destPath.title = last;
  }
  if (api.getVersion && els.version) {
    try {
      const v = await api.getVersion();
      if (v) els.version.textContent = `v${v}`;
    } catch {
      /* version is cosmetic */
    }
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
