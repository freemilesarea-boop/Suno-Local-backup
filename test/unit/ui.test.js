'use strict';

const fs = require('fs');
const path = require('path');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'renderer');
const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
const rendererJs = fs.readFileSync(path.join(rendererDir, 'renderer.js'), 'utf8');
const preloadJs = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'preload.js'), 'utf8');

describe('UI: localization + structure', () => {
  test('key Korean labels are present', () => {
    for (const label of ['Suno 곡 URL', '출력 형식', '저장 폴더', '폴더 선택', '다운로드 시작', '실패 항목 다시 시도', '작업 목록']) {
      expect(html).toContain(label);
    }
  });

  test('all four output formats are preserved', () => {
    for (const v of ['original', 'mp3', 'wav', 'mp3+wav']) {
      expect(html).toContain(`value="${v}"`);
    }
  });

  test('required element ids for the renderer bindings exist', () => {
    for (const id of ['urls', 'url-summary', 'choose-folder', 'dest-path', 'start', 'retry', 'global-status', 'queue', 'queue-empty']) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  test('empty state and footer version placeholder present', () => {
    expect(html).toContain('아직 다운로드 작업이 없습니다');
    expect(html).toContain('id="app-version"');
  });
});

describe('UI: event bindings preserved', () => {
  test('renderer wires start / retry / folder / job updates', () => {
    expect(rendererJs).toContain('startImport');
    expect(rendererJs).toContain('retryFailed');
    expect(rendererJs).toContain('chooseFolder');
    expect(rendererJs).toContain('onJobUpdate');
    expect(rendererJs).toContain("api.startImport");
    expect(rendererJs).toContain("api.retryFailed");
  });

  test('Korean status + error maps exist', () => {
    expect(rendererJs).toContain('KO_STATUS');
    expect(rendererJs).toContain('KO_ERROR');
    expect(rendererJs).toContain('SOURCE_NOT_AVAILABLE');
  });

  test('SOURCE_BLOCKED shows the honest signed-URL message pointing to official Download', () => {
    expect(rendererJs).toContain('SOURCE_BLOCKED');
    expect(rendererJs).toMatch(/서명된 URL/);
    expect(rendererJs).toMatch(/Download/);
  });

  test('audit UI is present and localized, watermark not shown as "safe"', () => {
    expect(rendererJs).toContain('buildAuditSection');
    expect(rendererJs).toContain('KO_AI');
    expect(rendererJs).toContain('KO_RIGHTS');
    expect(rendererJs).toContain('파일 분석');
    expect(rendererJs).toContain('비가시 워터마크');
    // Watermark UNKNOWN must not be painted green "safe".
    expect(rendererJs).not.toMatch(/워터마크[^]*state-green/);
  });
});

describe('UI: CSP safety (no inline styles, no policy weakening)', () => {
  test('CSP keeps style-src self and does NOT use unsafe-inline', () => {
    expect(html).toContain("style-src 'self'");
    expect(html).not.toContain('unsafe-inline');
    expect(rendererJs).not.toContain('unsafe-inline');
  });

  test('index.html has no inline style attributes', () => {
    expect(html).not.toMatch(/\sstyle=/);
  });

  test('renderer.js does not inject inline style attributes or setAttribute("style")', () => {
    // Building `style="..."` strings (e.g. via innerHTML) violates style-src.
    expect(rendererJs).not.toMatch(/style="/);
    expect(rendererJs).not.toMatch(/setAttribute\(\s*['"]style['"]/);
    // User/metadata is never injected as raw HTML.
    expect(rendererJs).not.toMatch(/\.innerHTML\s*=/);
  });
});

describe('UI: preload surface stays minimal + validated', () => {
  test('exposes only the expected channels', () => {
    for (const ch of ['dialog:selectFolder', 'config:getLastDir', 'urls:parse', 'import:start', 'import:retryFailed', 'app:getVersion', 'shell:revealPath']) {
      expect(preloadJs).toContain(ch);
    }
    // No raw ipcRenderer / require exposure.
    expect(preloadJs).not.toContain('exposeInMainWorld(\'suno\', ipcRenderer');
  });
});
