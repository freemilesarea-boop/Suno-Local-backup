'use strict';

const fs = require('fs');
const path = require('path');
const { AudioProcessor } = require('../src/core/audio');
const { makeTempDir, rmrf, ensureAudioFixtures } = require('./helpers/fixtures');

describe('AudioProcessor (real ffmpeg/ffprobe)', () => {
  let dir;
  let fixtures;
  const audio = new AudioProcessor();

  beforeAll(() => {
    fixtures = ensureAudioFixtures();
  });
  beforeEach(() => (dir = makeTempDir()));
  afterEach(() => rmrf(dir));

  test('T24 valid MP3 recognized', async () => {
    const info = await audio.probe(fixtures.mp3);
    expect(info.codec).toBe('mp3');
    expect(info.duration).toBeGreaterThan(0);
    expect(info.channels).toBe(2);
  });

  test('T25 valid WAV recognized', async () => {
    const info = await audio.probe(fixtures.wav);
    expect(info.codec).toMatch(/pcm/);
    expect(info.sampleRate).toBe(44100);
    expect(info.duration).toBeGreaterThan(0);
  });

  test('T26 corrupt audio rejected', async () => {
    await expect(audio.probe(fixtures.corrupt)).rejects.toThrow();
    expect(await audio.isValidAudio(fixtures.corrupt)).toBe(false);
  });

  test('T27 MP3 -> WAV succeeds', async () => {
    const out = path.join(dir, 'out.wav');
    await audio.toWav(fixtures.mp3, out);
    const info = await audio.probe(out);
    expect(info.codec).toMatch(/pcm/);
    expect(info.duration).toBeGreaterThan(0);
    expect(fs.existsSync(out + '.part')).toBe(false);
  });

  test('T28 WAV -> MP3 succeeds', async () => {
    const out = path.join(dir, 'out.mp3');
    await audio.toMp3(fixtures.wav, out);
    const info = await audio.probe(out);
    expect(info.codec).toBe('mp3');
    expect(info.duration).toBeGreaterThan(0);
  });

  test('T29 source sample rate preserved (WAV -> MP3 keeps 44100)', async () => {
    const out = path.join(dir, 'sr.mp3');
    await audio.toMp3(fixtures.wav, out);
    const info = await audio.probe(out);
    expect(info.sampleRate).toBe(44100);
  });

  test('T30 output duration sanity check (within tolerance)', async () => {
    const src = await audio.probe(fixtures.wav);
    const out = path.join(dir, 'd.wav');
    await audio.toWav(fixtures.mp3, out);
    const dst = await audio.probe(out);
    expect(Math.abs(dst.duration - src.duration)).toBeLessThan(0.3);
  });

  test('T41b filename with shell metacharacters is handled literally (no injection)', async () => {
    // A malicious "title" as a real filename. Because we use execFile with an
    // argument array (never a shell string), the ; and $() are inert.
    const evil = path.join(dir, 'a; touch INJECTED $(whoami).wav');
    fs.copyFileSync(fixtures.wav, evil);
    const out = path.join(dir, 'safe.mp3');
    await audio.toMp3(evil, out);
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'INJECTED'))).toBe(false);
    expect(fs.existsSync(path.join(process.cwd(), 'INJECTED'))).toBe(false);
  });
});
