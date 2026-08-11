# Ver Booster

A local-first desktop tool to **back up, organize, and convert Suno songs you
have legitimate access to**. Paste one or more Suno song URLs, choose an output
format (Original / MP3 / WAV / MP3 + WAV) and a destination folder, and the app
downloads, verifies, converts, and files each track locally — with a clear
per-track status queue.

> **Scope & boundaries.** This tool only handles content a user can already
> access normally. It performs **no** authentication bypass, DRM removal,
> paywall/quota circumvention, credential capture, or access-control evasion.
> When legitimate access to a source cannot be verified, it **fails closed**
> (`AUTH_REQUIRED` / `NOT_AVAILABLE` / `POLICY_BLOCKED`) rather than trying
> to obtain the audio some other way.

## Stack

- **Electron** desktop shell (`contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`; renderer talks to main only through a small validated IPC
  bridge).
- **Node core modules** for all pipeline logic — pure, Electron-free, and
  unit-tested.
- **ffmpeg-static / @ffprobe-installer/ffprobe** for audio validation and
  conversion (invoked via `execFile` with argument arrays — never a shell
  string). `@ffprobe-installer` selects a native per-arch binary (a real arm64
  Mach-O on Apple Silicon).
- **Jest** for tests.

## Architecture

```
Renderer (HTML/CSS/JS)
  ⇅ preload contextBridge (6 validated channels)
Main process
  └─ ImportController              orchestrates each job
       ├─ SunoAdapter   (url.js)   validate / normalize / id / metadata   ← Suno-specific
       ├─ SourceResolver           availability decision + host allowlist  ← Suno-specific
       ├─ Downloader               http, .part staging, atomic finalize, retry, SSRF guard
       ├─ AudioProcessor           ffprobe verify + ffmpeg MP3/WAV convert
       ├─ StorageManager           filename sanitize, path-traversal guard, collision-safe
       └─ MetadataManager          JSON sidecar + duplicate index
```

Suno-specific knowledge is confined to `url.js`, `suno-adapter.js`, and
`resolver.js`. If Suno's web structure changes, those are the only files that
need updating — the generic download/convert/storage layers stay put.

Per-job lifecycle:
`QUEUED → VALIDATING → RESOLVING → DOWNLOADING → VERIFYING → CONVERTING → SAVING → COMPLETED`
(or `FAILED` / `SKIPPED_DUPLICATE` / `CANCELLED`).

## Safety properties

- **Fail closed** on unknown/unauthorized sources; `UNKNOWN` is never treated as
  available.
- **SSRF guard**: the downloader refuses non-`http(s)` protocols, localhost /
  private IP ranges, and any host not on the resolver-approved allowlist.
- **No partial finalization**: audio streams to `<file>.part` and is atomically
  renamed only after zero-byte / HTML-page / size sanity checks pass. Failures
  clean up the temp file — an incomplete download is never left as a finished
  one.
- **No overwrite**: filename collisions are suffixed, never clobbered.
- **Secret redaction**: logs redact Authorization/Cookie/token/signed-URL query
  secrets.

## Develop / test / build

```bash
npm install          # installs deps (ffmpeg-static, @ffprobe-installer/ffprobe, electron, jest)
npm test             # run the Jest suite
npm start            # launch the app (electron .)
npm run build        # electron-builder (per-OS targets configured in package.json)
```

## Status

P0 MVP. Cover-image saving, job cancellation UI, and richer batch UX are P1.
See the phase report for the full definition-of-done checklist.
