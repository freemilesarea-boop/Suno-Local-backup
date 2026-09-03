'use strict';

/**
 * READ-ONLY source diagnostic (no download, no convert, no auth, no bypass).
 *
 * Question: does the ANONYMOUS (logged-out) public song page already hand the
 * browser a *playable* audio URL — i.e. a signed URL (with query) or embedded
 * stream data — the way playback works for everyone? If so, using that exact
 * resource is normal public resolution, and our bug is that the extractor
 * truncates the signed URL at ".mp3" (dropping the signature -> 403).
 *
 * It sends NO cookies/auth and attempts NO bypass. Signed-URL query VALUES are
 * never printed — only the presence of the query keys (so we can see it is
 * signed without leaking the token).
 */

const { parseSunoUrl } = require('../src/core/url');
const { sunoFetchRaw } = require('../src/core/factory');

// Keep origin+path; show query KEYS but mask their values.
function redactUrl(u) {
  try {
    const p = new URL(u.replace(/\\u002[fF]/g, '/').replace(/\\\//g, '/'));
    const keys = [...p.searchParams.keys()];
    const q = keys.length ? ` ?[${keys.join('&')}]` : ' (no query)';
    return `${p.protocol}//${p.host}${p.pathname}${q}`;
  } catch {
    return '(unparseable)';
  }
}

// Ranged GET; prints status/type only. Uses the FULL url (incl. any signature).
function rangedProbe(fullUrl) {
  const https = require('https');
  return new Promise((resolve) => {
    let req;
    try {
      req = https.get(fullUrl, { headers: { 'user-agent': 'VerBooster/0.1', accept: '*/*', range: 'bytes=0-15' } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const b = Buffer.concat(chunks);
          resolve({ status: res.statusCode, contentType: res.headers['content-type'] || null, contentRange: res.headers['content-range'] || null, firstAscii: b.toString('latin1').replace(/[^\x20-\x7e]/g, '.').slice(0, 12) });
        });
      });
    } catch { return resolve({ error: 'bad url' }); }
    req.setTimeout(20000, () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.on('error', (e) => resolve({ error: e.message }));
  });
}

// Recursively collect string values under audio-ish keys from parsed JSON.
function collectAudioUrls(obj, out, depth = 0) {
  if (!obj || depth > 8) return;
  if (Array.isArray(obj)) { for (const v of obj) collectAudioUrls(v, out, depth + 1); return; }
  if (typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && /^https?:\/\//.test(v) && /audio|stream|\.mp3|\.m4a|\.wav|cdn.*suno/i.test(k + ' ' + v)) {
      out.push({ key: k, url: v });
    } else if (v && typeof v === 'object') {
      collectAudioUrls(v, out, depth + 1);
    }
  }
}

async function main() {
  const url = process.argv[2] || process.env.SONG_URL;
  if (!url) { console.error('no url'); process.exit(2); }
  const parsed = parseSunoUrl(url);
  console.log('\n================ DIAGNOSE', url, '================');
  if (!parsed.ok) { console.log('[parse] FAIL', parsed.reason); return; }
  const id = parsed.id;

  let page;
  try { page = await sunoFetchRaw(`https://suno.com/song/${id}`); }
  catch (e) { console.log('[page] ERROR', e.code || e.message); return; }
  const body = page.body ? String(page.body) : '';
  console.log('[page]', JSON.stringify({ status: page.statusCode, bytes: body.length, idInHtml: body.includes(id) }));

  // 1) Any FULL audio URL for this id, INCLUDING query (signature), in raw HTML.
  const fullRe = new RegExp('https?:\\\\?/\\\\?/[a-z0-9.-]*suno[a-z0-9.-]*/[^"\'\\\\\\s]*' + id + '[^"\'\\\\\\s]*', 'ig');
  const rawHits = [...new Set((body.match(fullRe) || []).map((s) => s.replace(/\\u002[fF]/g, '/').replace(/\\\//g, '/')))];
  console.log('\n[raw id-bearing suno urls]', rawHits.length);
  rawHits.slice(0, 20).forEach((u, i) => console.log(`  #${i} ${redactUrl(u)}${/\.(mp3|m4a|wav|ogg|opus|flac)/i.test(u) ? '' : ' (not-audio-ext)'}`));

  // 2) __NEXT_DATA__ (and any application/json script) parsed for audio urls.
  const scripts = [...body.matchAll(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  console.log('\n[json script blocks]', scripts.length);
  const audioFromJson = [];
  for (const s of scripts) {
    try { collectAudioUrls(JSON.parse(s), audioFromJson); } catch { /* not json */ }
  }
  const uniqJson = [...new Map(audioFromJson.map((a) => [a.url, a])).values()];
  console.log('[audio urls in embedded json]', uniqJson.length);
  uniqJson.slice(0, 20).forEach((a, i) => console.log(`  #${i} key=${a.key} -> ${redactUrl(a.url)}${a.url.includes(id) ? ' (matches id)' : ''}`));

  // 3) Probe the most promising PLAYABLE candidate: an id-bearing url that has a
  //    query (signed), preferring embedded-json ones, then raw ones.
  const signedCandidates = [
    ...uniqJson.map((a) => a.url).filter((u) => u.includes(id) && u.includes('?')),
    ...rawHits.filter((u) => u.includes('?') && /\.(mp3|m4a|wav|ogg|opus|flac)/i.test(u)),
    ...uniqJson.map((a) => a.url).filter((u) => u.includes(id)),
  ];
  const target = signedCandidates[0];
  if (target) {
    console.log('\n[probe signed candidate]', redactUrl(target));
    console.log('  ->', JSON.stringify(await rangedProbe(target)));
  } else {
    console.log('\n[probe] no signed/playable candidate found in anonymous page');
  }
}

main().catch((e) => { console.error('DIAGNOSE_ERROR', e && e.message); process.exit(10); });
