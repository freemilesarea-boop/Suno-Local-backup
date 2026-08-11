'use strict';

/**
 * READ-ONLY diagnostic (no downloads, no code paths changed). Investigates how a
 * public Suno song exposes its audio resource, so we can see:
 *   - the real metadata endpoint HTTP status + schema
 *   - whether an audio/media field exists, its name, host, and content-type
 *   - what the public song page itself embeds for playback
 *
 * Only two kinds of requests are made, both legitimate/public:
 *   1. the metadata endpoint the app already uses (studio-api.suno.ai/api/clip/<id>)
 *   2. the public song page (https://suno.com/song/<uuid>)
 * No cookies/auth are sent. URL query strings are redacted (may hold signed
 * secrets); hosts + paths + field names are printed. No CDN URLs are guessed.
 */

const https = require('https');

function get(url, headers) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      { headers: headers || { 'user-agent': 'SunoLocalBackup/0.1', accept: '*/*' } },
      (res) => {
        const chunks = [];
        let total = 0;
        res.on('data', (c) => {
          total += c.length;
          if (total <= 6 * 1024 * 1024) chunks.push(c);
        });
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), location: res.headers.location || null })
        );
        res.on('error', () => resolve({ status: 'res_error' }));
      }
    );
    req.setTimeout(20000, () => { req.destroy(); resolve({ status: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 'error', detail: e.message }));
  });
}

function redactUrl(u) {
  try {
    const p = new URL(u);
    return `${p.protocol}//${p.host}${p.pathname}${p.search ? '?[REDACTED]' : ''}`;
  } catch {
    return '(unparseable)';
  }
}

// Pull a few interesting fields out of an arbitrary object (deep) by key name.
function findFields(obj, keys, out = {}, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (keys.includes(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
      const val = typeof v === 'string' && /^https?:\/\//.test(v) ? redactUrl(v) : v;
      if (!(k in out)) out[k] = val;
    }
    if (v && typeof v === 'object') findFields(v, keys, out, depth + 1);
  }
  return out;
}

async function main() {
  const url = process.argv[2] || process.env.SONG_URL;
  if (!url) { console.error('No SONG_URL'); process.exit(2); }
  const m = url.match(/\/song\/([0-9a-f-]{36})/i);
  if (!m) { console.error('URL is not /song/<uuid>'); process.exit(2); }
  const id = m[1].toLowerCase();
  console.log('=== SOURCE DIAGNOSE ===');
  console.log('song id:', id);

  const AUDIO_KEYS = ['audio_url', 'audioUrl', 'mp3_url', 'stream_url', 'source_audio_url', 'video_url', 'image_url', 'is_public', 'is_video_pending', 'title', 'status', 'duration'];

  // 1) Metadata endpoints the app uses.
  for (const ep of [`https://studio-api.suno.ai/api/clip/${id}`, `https://studio-api.suno.com/api/clip/${id}`]) {
    const r = await get(ep, { 'user-agent': 'SunoLocalBackup/0.1', accept: 'application/json' });
    console.log(`\n[meta] ${ep.replace(id, '<id>')}`);
    console.log('  status=', r.status, 'ct=', r.headers && r.headers['content-type'], 'len=', r.body ? r.body.length : 0, r.location ? 'loc=' + r.location : '');
    if (r.body && /^[\s]*[[{]/.test(r.body)) {
      try {
        const json = JSON.parse(r.body);
        console.log('  topKeys=', JSON.stringify(Object.keys(json).slice(0, 40)));
        console.log('  fields=', JSON.stringify(findFields(json, AUDIO_KEYS)));
      } catch (e) {
        console.log('  json parse failed:', e.message, '| head=', JSON.stringify(r.body.slice(0, 200)));
      }
    } else if (r.body) {
      console.log('  non-json head=', JSON.stringify(r.body.slice(0, 200)));
    }
  }

  // 2) Public song page — follow one redirect if needed.
  let pageUrl = `https://suno.com/song/${id}`;
  let page = await get(pageUrl, { 'user-agent': 'Mozilla/5.0', accept: 'text/html,application/xhtml+xml,*/*' });
  if (page.status >= 300 && page.status < 400 && page.location) {
    pageUrl = new URL(page.location, pageUrl).toString();
    page = await get(pageUrl, { 'user-agent': 'Mozilla/5.0', accept: 'text/html,*/*' });
  }
  console.log(`\n[page] https://suno.com/song/<id>`);
  console.log('  status=', page.status, 'ct=', page.headers && page.headers['content-type'], 'len=', page.body ? page.body.length : 0);
  const body = page.body || '';
  // og:audio and audio hosts
  const og = body.match(/<meta[^>]+property=["']og:audio["'][^>]+content=["']([^"']+)["']/i);
  console.log('  og:audio=', og ? redactUrl(og[1]) : null);
  const hosts = Array.from(new Set((body.match(/https?:\/\/[a-z0-9.-]*suno[a-z0-9.-]*\/[^"'\\\s]*\.(?:mp3|m4a|wav|ogg|opus|flac)/gi) || []).map(redactUrl))).slice(0, 8);
  console.log('  audioFileUrls=', JSON.stringify(hosts));
  const audioHostList = Array.from(new Set((body.match(/https?:\/\/(cdn[0-9]*|audiopipe|cdn-[a-z]+)\.suno[a-z.]+/gi) || []))).slice(0, 8);
  console.log('  cdnHosts=', JSON.stringify(audioHostList));
  // Embedded Next.js/JSON data
  const nextData = body.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nextData) {
    console.log('  __NEXT_DATA__ present len=', nextData[1].length);
    try {
      const json = JSON.parse(nextData[1]);
      console.log('  nextFields=', JSON.stringify(findFields(json, AUDIO_KEYS)));
    } catch (e) {
      console.log('  next parse failed:', e.message);
      const au = nextData[1].match(/"audio_url":"([^"]+)"/i);
      if (au) console.log('  raw audio_url=', redactUrl(au[1].replace(/\\u002F/g, '/')));
    }
  } else {
    console.log('  __NEXT_DATA__ absent');
    const au = body.match(/"audio_url":"([^"]+)"/i);
    if (au) console.log('  raw audio_url in body=', redactUrl(au[1].replace(/\\u002F/g, '/')));
  }

  // 3) Verify PUBLIC access to the audio file referenced by the page. We pick
  //    the URL whose filename matches the clip id (not the silence placeholder),
  //    and do a bounded ranged GET. This is the exact resource the public page
  //    references — nothing is guessed.
  const candidates = Array.from(new Set(body.match(/https?:\/\/[a-z0-9.-]*suno[a-z0-9.-]*\/[^"'\\\s]*\.(?:mp3|m4a|wav|ogg|opus|flac)/gi) || []));
  const audioUrl = candidates.find((u) => u.toLowerCase().includes(id)) || null;
  console.log('\n[audio-access] chosenUrlHostPath=', audioUrl ? redactUrl(audioUrl) : null);
  if (audioUrl) {
    const r = await get(audioUrl, { 'user-agent': 'SunoLocalBackup/0.1', accept: '*/*', range: 'bytes=0-1023' });
    console.log('  status=', r.status, 'ct=', r.headers && r.headers['content-type'], 'len=', r.headers && r.headers['content-length'], 'acceptRanges=', r.headers && r.headers['accept-ranges']);
    // Sniff: is it audio (ID3/MPEG frame) rather than HTML/JSON?
    const head = r.body ? Buffer.from(r.body.slice(0, 4)) : Buffer.alloc(0);
    const looksAudio = head.length >= 2 && ((head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0));
    console.log('  looksAudio=', looksAudio, 'firstBytesHex=', head.toString('hex'));
  }
}

main().catch((e) => { console.error('DIAG_ERROR:', e.message); process.exit(10); });
