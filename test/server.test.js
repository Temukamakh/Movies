import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startServer } from './helpers.js';

const video = Buffer.from(Array.from({ length: 200_000 }, (_, i) => i % 251));
let s;

before(async () => {
  s = await startServer({
    password: 'correct horse',
    files: {
      'movies/Heat.1995.1080p.BluRay.mp4': video,
      'tv/Lost/Season 1/Lost.S01E01.Pilot.mp4': video,
      'tv/Lost/Season 1/Lost.S01E02.mp4': video,
      'Downloads/Arrival (2016)/Arrival.2016.mp4': video,
      'Downloads/Arrival (2016)/Arrival.2016.en.srt': '1\n00:00:01,000 --> 00:00:02,000\nHello\n',
    },
  });
});
after(() => s.stop());

async function library() {
  const { body } = await s.json('/api/library');
  return body;
}

test('everything but the login screen needs a password', async () => {
  s.logout();
  assert.equal((await s.request('/api/library')).status, 401);
  assert.equal((await s.request('/api/stream/abc')).status, 401);
  assert.deepEqual((await s.json('/api/session')).body, { authenticated: false, configured: true, canSetup: false });
  assert.equal((await s.json('/api/login', { password: 'nope' })).status, 401);
  assert.equal((await s.json('/api/setup', { password: 'hijack123' })).status, 409);
  assert.equal((await s.json('/api/login', { password: 'correct horse' })).status, 200);
  assert.equal((await s.json('/api/session')).body.authenticated, true);
});

test('the media folder becomes a library of movies and shows', async () => {
  const lib = await library();
  const titles = lib.items.map((i) => `${i.kind}:${i.title}:${i.year ?? ''}`).sort();
  assert.deepEqual(titles, ['episode::', 'episode:Pilot:', 'movie:Arrival:2016', 'movie:Heat:1995']);
  assert.equal(lib.shows.length, 1);
  assert.equal(lib.shows[0].title, 'Lost');
  assert.equal(lib.shows[0].episodeIds.length, 2);
  const arrival = lib.items.find((i) => i.title === 'Arrival');
  assert.deepEqual(arrival.subtitles.map((t) => t.label), ['English']);
  assert.equal(arrival.status, 'ready');
});

test('videos stream with byte ranges, and signed URLs work without a cookie', async () => {
  const heat = (await library()).items.find((i) => i.title === 'Heat');
  const res = await s.request(`/api/stream/${heat.id}`, { headers: { range: 'bytes=1000-1009' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 1000-1009/${video.length}`);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), video.subarray(1000, 1010));

  const tail = await s.request(`/api/stream/${heat.id}`, { headers: { range: 'bytes=-10' } });
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()), video.subarray(-10));
  assert.equal((await s.request(`/api/stream/${heat.id}`, { headers: { range: `bytes=${video.length}-` } })).status, 416);

  const noCookie = (p) => fetch(s.base + p, { headers: { range: 'bytes=0-1' } });
  assert.equal((await noCookie(`/api/stream/${heat.id}?t=${heat.token}`)).status, 206);
  assert.equal((await noCookie(`/api/stream/${heat.id}?t=${heat.token}x`)).status, 401);
  const other = (await library()).items.find((i) => i.title === 'Arrival');
  assert.equal((await noCookie(`/api/stream/${other.id}?t=${heat.token}`)).status, 401, 'a token only unlocks its own video');
});

test('sidecar .srt files are served as WebVTT', async () => {
  const arrival = (await library()).items.find((i) => i.title === 'Arrival');
  const res = await s.request(`/api/subtitles/${arrival.id}/${arrival.subtitles[0].id}.vtt`);
  assert.equal(res.headers.get('content-type'), 'text/vtt; charset=utf-8');
  assert.equal(await res.text(), 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nHello\n');
});

test('watch progress is saved and marks things watched near the end', async () => {
  const heat = (await library()).items.find((i) => i.title === 'Heat');
  let r = await s.json(`/api/progress/${heat.id}`, { position: 3000, duration: 10000 });
  assert.equal(r.body.watched, false);
  // sendBeacon posts JSON as text/plain
  const beacon = await s.request(`/api/progress/${heat.id}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ position: 4200, duration: 10000 }) });
  assert.equal(beacon.status, 200);
  let saved = (await library()).items.find((i) => i.id === heat.id).progress;
  assert.equal(saved.position, 4200);
  assert.equal(saved.watched, false);

  r = await s.json(`/api/progress/${heat.id}`, { position: 9500, duration: 10000 });
  assert.equal(r.body.watched, true);
  await s.json(`/api/items/${heat.id}/watched`, { watched: false });
  saved = (await library()).items.find((i) => i.id === heat.id).progress;
  assert.equal(saved, null);
  assert.equal((await s.json(`/api/progress/${heat.id}`, { position: -5, duration: 10 })).status, 400);
});

async function upload(fields, data, name) {
  const created = await s.json('/api/uploads', { key: `${name}|${data.length}|1`, filename: name, size: data.length, ...fields });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const { uploadId } = created.body;
  const half = Math.floor(data.length / 2);
  const put = (offset, body) => s.request(`/api/uploads/${uploadId}?offset=${offset}`, { method: 'PUT', body });
  assert.equal((await put(0, data.subarray(0, half))).status, 200);
  // A retry of a chunk the server already has is refused with the real offset.
  const stale = await put(0, data.subarray(0, half));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).offset, half);
  assert.equal((await s.json(`/api/uploads/${uploadId}`)).body.offset, half);
  assert.equal((await put(half, data.subarray(half))).status, 200);
  const done = await s.json(`/api/uploads/${uploadId}/complete`, {});
  assert.equal(done.status, 200, JSON.stringify(done.body));
  return done.body;
}

test('uploading a movie files it under movies/ with the typed title', async () => {
  const data = Buffer.alloc(300_000, 7);
  const item = await upload({ kind: 'movie', title: 'Dune: Part Two', year: 2024 }, data, 'Dune.Part.Two.2024.2160p.mp4');
  assert.equal(item.title, 'Dune: Part Two');
  assert.equal(item.year, 2024);
  const onDisk = await fs.readFile(path.join(s.mediaDir, 'movies', 'Dune - Part Two (2024).mp4'));
  assert.ok(onDisk.equals(data));
});

test('uploading episodes groups them into the right show and season', async () => {
  const item = await upload({ kind: 'episode', show: 'Lost', season: 1, episode: 3, title: 'Tabula Rasa' }, Buffer.alloc(1000, 3), 'lost.103.mkv');
  assert.equal(item.kind, 'episode');
  assert.equal(item.show, 'Lost');
  assert.equal(item.episode, 3);
  await fs.access(path.join(s.mediaDir, 'tv', 'Lost', 'Season 1', 'Lost - S01E03 - Tabula Rasa.mkv'));
  const lib = await library();
  assert.equal(lib.shows.find((x) => x.title === 'Lost').episodeIds.length, 3);
  assert.equal(item.status, 'limited', 'MKV without ffmpeg may not play on iPhone');
});

test('uploads reject files that are not videos', async () => {
  const r = await s.json('/api/uploads', { filename: 'notes.txt', size: 10, kind: 'movie', title: 'x' });
  assert.equal(r.status, 400);
  const r2 = await s.json('/api/uploads', { filename: 'ep.mp4', size: 10, kind: 'episode', show: '  ' });
  assert.equal(r2.status, 400);
});

test('subtitles can be added and removed', async () => {
  const heat = (await library()).items.find((i) => i.title === 'Heat');
  const res = await s.request(`/api/items/${heat.id}/subtitles?filename=Heat.1995.fr.srt`, {
    method: 'POST', headers: { 'content-type': 'text/plain' }, body: '1\n00:00:01,500 --> 00:00:03,000\nBonjour\n',
  });
  const updated = await res.json();
  assert.equal(updated.subtitles.length, 1);
  assert.equal(updated.subtitles[0].label, 'French');
  const vtt = await (await s.request(`/api/subtitles/${heat.id}/${updated.subtitles[0].id}.vtt`)).text();
  assert.match(vtt, /^WEBVTT\n\n1\n00:00:01\.500 --> 00:00:03\.000\nBonjour/);
  const removed = await s.json(`/api/items/${heat.id}/subtitles/${updated.subtitles[0].id}`, undefined, 'DELETE');
  assert.equal(removed.body.subtitles.length, 0);
});

test('titles can be edited and shows renamed', async () => {
  const heat = (await library()).items.find((i) => i.title === 'Heat');
  const edited = await s.json(`/api/items/${heat.id}`, { title: 'Heat (Director’s Cut)', year: 1995 }, 'PATCH');
  assert.equal(edited.body.title, 'Heat (Director’s Cut)');
  const show = (await library()).shows.find((x) => x.title === 'Lost');
  const renamed = await s.json(`/api/shows/${show.id}`, { title: 'LOST' }, 'PATCH');
  const lib = await library();
  assert.equal(lib.shows.find((x) => x.id === renamed.body.id).title, 'LOST');
  assert.equal(lib.shows.length, 1);
});

test('deleting a movie removes the file from disk', async () => {
  const arrival = (await library()).items.find((i) => i.title === 'Arrival');
  assert.equal((await s.json(`/api/items/${arrival.id}`, undefined, 'DELETE')).status, 200);
  await assert.rejects(fs.access(path.join(s.mediaDir, 'Downloads', 'Arrival (2016)', 'Arrival.2016.mp4')));
  await assert.rejects(fs.access(path.join(s.mediaDir, 'Downloads', 'Arrival (2016)')), 'empty folder is tidied up');
  assert.ok(!(await library()).items.some((i) => i.id === arrival.id));
});

test('the web app is served, but nothing outside public/', async () => {
  const res = await fetch(`${s.base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await fetch(`${s.base}/js/app.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await fetch(`${s.base}/%2e%2e/package.json`)).status, 404);
  assert.equal((await fetch(`${s.base}/..%2f..%2fpackage.json`)).status, 404);
});
