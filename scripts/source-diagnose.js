'use strict';

/**
 * READ-ONLY source diagnostic (no download, no convert, no auth, no bypass).
 *
 * Given a PUBLIC Suno song URL, it prints exactly what the app's own code path
 * sees, so we can root-cause a "download did not complete" failure:
 *   parse -> studio-api clip status -> public page status -> which audio URLs
 *   the page exposes (host+path only; query redacted) -> what the app's
 *   extractor finds -> a ranged GET status on the best candidate -> resolver.
 *
 * It never sends cookies/auth and never attempts a bypass. Signed-URL query
 * strings are stripped before printing.
 */

const { parseSunoUrl } = require('../src/core/url');
const { SunoAdapter, extractPageAudioUrl, isSunoHost } = require('../src/core/suno-adapter');
const { SourceResolver, Availability } = require('../src/core/resolver');
const { sunoFetchJson, sunoFetchRaw } = require('../src/core/factory');

function loc(u) {
  try {
    const p = new URL(u);
    return `${p.protocol}//${p.host}${p.pathname}`; // NO query (may hold signed secrets)
  } catch {
    return '(unparseable)';
  }
}

// All Suno-host media URLs the page exposes, with audio-ish extensions.
function allAudioCandidates(body) {
  if (!body) return [];
  const re = /https?:\\?\/\\?\/[a-z0-9.-]*suno[a-z0-9.-]*\/[^"'\\\s]+\.(?:mp3|m4a|wav|ogg|opus|flac)/gi;
  const seen = new Set();
  const out = [];
  let m;
  while ((m = re.exec(body)) !== null) {
    const url = m[0].replace(/\\u002[fF]/g, '/').replace(/\\\//g, '/');
    if (!seen.has(url)) { seen.add(url); out.push(url); }
  }
  return out;
}

// Distinct Suno CDN/media hostnames referenced anywhere on the page.
function allSunoHosts(body) {
  if (!body) return [];
  const re = /https?:\\?\/\\?\/([a-z0-9.-]*suno[a-z0-9.-]*)/gi;
  const seen = new Set();
  let m;
  while ((m = re.exec(body)) !== null) seen.add(m[1].toLowerCase());
  return [...seen].sort();
}

async function rangedProbe(url) {
  const https = require('https');
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve({ error: 'bad url' }); }
    const req = https.get(
      url,
      { headers: { 'user-agent': 'VerBooster/0.1', accept: '*/*', range: 'bytes=0-15' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const b = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            contentType: res.headers['content-type'] || null,
            acceptRanges: res.headers['accept-ranges'] || null,
            contentRange: res.headers['content-range'] || null,
            firstBytesHex: b.subarray(0, 8).toString('hex'),
            firstBytesAscii: b.toString('latin1').replace(/[^\x20-\x7e]/g, '.').slice(0, 16),
          });
        });
      }
    );
    req.setTimeout(20000, () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.on('error', (e) => resolve({ error: e.message }));
  });
}

async function main() {
  const url = process.argv[2] || process.env.SONG_URL;
  if (!url) { console.error('no url'); process.exit(2); }
  console.log('=== SOURCE DIAGNOSE (read-only) ===');
  console.log('url:', url);

  const parsed = parseSunoUrl(url);
  console.log('\n[parse]', JSON.stringify({ ok: parsed.ok, kind: parsed.kind, id: parsed.id, reason: parsed.reason }));
  if (!parsed.ok) process.exit(1);
  const id = parsed.id;

  const adapter = new SunoAdapter({ fetchJson: sunoFetchJson, fetchRaw: sunoFetchRaw });

  // 1) studio-api clip endpoints
  for (const ep of adapter.metadataEndpoints(id)) {
    try {
      const r = await sunoFetchJson(ep);
      console.log('[studio-api]', loc(ep), '->', JSON.stringify({ status: r.statusCode, hasJson: !!r.json, audioUrl: r.json && (r.json.audio_url ? loc(r.json.audio_url) : null) }));
    } catch (e) {
      console.log('[studio-api]', loc(ep), '-> ERROR', e.code || e.message);
    }
  }

  // 2) public page
  let page;
  try {
    page = await sunoFetchRaw(`https://suno.com/song/${id}`);
  } catch (e) {
    console.log('[page] fetch ERROR', e.code || e.message);
    process.exit(3);
  }
  const body = page.body ? String(page.body) : '';
  console.log('\n[page]', JSON.stringify({ status: page.statusCode, finalUrl: loc(page.finalUrl || ''), bytes: body.length, idPresentInHtml: body.includes(id) }));

  // 3) what audio does the page expose?
  console.log('\n[suno-hosts on page]', JSON.stringify(allSunoHosts(body)));
  const cands = allAudioCandidates(body);
  console.log('[audio candidates: count]', cands.length);
  cands.slice(0, 12).forEach((c, i) => {
    console.log(`  #${i} ${loc(c)}  ${c.includes(id) ? '(matches id)' : '(no id)'}`);
  });

  // 4) what the APP's extractor returns
  const appAudio = extractPageAudioUrl(body, id);
  console.log('\n[app.extractPageAudioUrl]', appAudio ? loc(appAudio) : 'NO MATCH (id-bearing audio url not found)');

  // 5) ranged probe on best candidate (app match first, else first id-bearing, else first)
  const probeTarget = appAudio || cands.find((c) => c.includes(id)) || cands[0];
  if (probeTarget) {
    console.log('[ranged GET]', loc(probeTarget), '->', JSON.stringify(await rangedProbe(probeTarget)));
  } else {
    console.log('[ranged GET] no candidate to probe');
  }

  // 6) full resolver verdict (the actual availability decision)
  const resolver = new SourceResolver({ adapter });
  try {
    const resolution = await resolver.resolve(parsed);
    console.log('\n[resolver]', JSON.stringify({ state: resolution.state, expectedHost: resolution.expectedHost, detail: resolution.detail }));
    console.log('AVAILABLE?', resolution.state === Availability.AVAILABLE);
  } catch (e) {
    console.log('\n[resolver] ERROR', e.message);
  }

  console.log('\n=== END DIAGNOSE ===');
}

main().catch((e) => { console.error('DIAGNOSE_ERROR', e && e.message); process.exit(10); });
