import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { Auth } from './auth.js';
import {
  HttpError, Router, clientAddress, isPrivateAddress, isProxied, networkUrls, readBody, readJson,
  sendFile, sendJson,
} from './http.js';
import { JobQueue } from './jobs.js';
import { CONVERTING_SUFFIX, Library, subtitleFileLabel } from './library.js';
import { Media, planFor } from './media.js';
import { JsonStore } from './store.js';
import { Uploads, freeSpace } from './uploads.js';
import { stripExt } from '../public/js/parse.js';

const VIDEO_TYPES = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm', mkv: 'video/webm',
  avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv', flv: 'video/x-flv', ts: 'video/mp2t', m2ts: 'video/mp2t',
  mts: 'video/mp2t', mpg: 'video/mpeg', mpeg: 'video/mpeg', '3gp': 'video/3gpp', ogv: 'video/ogg', divx: 'video/x-msvideo',
};
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
};
const BROWSER_PLAYABLE_EXTS = new Set(['mp4', 'm4v', 'mov', 'webm']);
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};
const CSP = "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; " +
  "script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'";
const ART_KEY = /^s?[a-f0-9]{11,16}$/;
const MAX_IMAGE = 8 * 1024 * 1024;
const RESCAN_AFTER_MS = 15_000;

/** A finished viewing: 93% through, or within the last minute of anything longer than 5 minutes. */
export function isWatched(position, duration) {
  return duration > 0 && position > 0 && (position / duration >= 0.93 || (duration > 300 && duration - position < 60));
}

export function srtToVtt(text) {
  const body = text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .replace(/\{\\[^}]*\}/g, '');
  return body.trimStart().startsWith('WEBVTT') ? body : `WEBVTT\n\n${body}`;
}

/** Subtitle files come in all sorts of encodings; fall back to Windows-1252 when not UTF-8. */
function decodeText(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

const isJpeg = (buf) => buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;

export async function createApp(config) {
  const log = config.quiet ? () => {} : (...args) => console.log(`[${new Date().toLocaleTimeString()}]`, ...args);
  const { mediaDir, dataDir } = config;
  const dirs = {
    thumbs: path.join(dataDir, 'thumbs'),
    posters: path.join(dataDir, 'posters'),
  };
  for (const dir of [path.join(mediaDir, 'movies'), path.join(mediaDir, 'tv'), dataDir, ...Object.values(dirs)]) {
    await fsp.mkdir(dir, { recursive: true });
  }

  const db = new JsonStore(path.join(dataDir, 'library.json'), { items: {}, shows: {}, progress: {} });
  const auth = new Auth({ dataDir, password: config.password });
  await auth.init();
  const media = new Media({ enabled: config.useFfmpeg, ffmpegPath: config.ffmpegPath, ffprobePath: config.ffprobePath });
  await media.detect();
  const library = new Library({ mediaDir, dataDir, db });
  const uploads = new Uploads({ dataDir, mediaDir });
  await uploads.init();
  const quick = new JobQueue(log); // probing, thumbnails, subtitle extraction
  const heavy = new JobQueue(log); // conversions

  // ---------------------------------------------------------------- background processing

  const fileKey = (item) => `${item.size}:${item.mtimeMs}`;
  /** The probe result for the file as it is now (not for an earlier file with the same name). */
  const currentProbe = (item) => {
    const probe = db.data.items[item.id]?.probe;
    return probe?.key === fileKey(item) ? probe : null;
  };

  const displayName = (item) =>
    item.kind === 'episode' ? `${item.show} S${item.season}E${item.episode ?? '?'}` : item.title;

  async function rescan() {
    await library.scan();
    schedule();
    return library;
  }

  function schedule() {
    if (!media.available) return;
    for (const item of library.items.values()) {
      const rec = library.record(item.id);
      const key = fileKey(item);
      const info = { itemId: item.id };
      if (!currentProbe(item)) {
        quick.add(`probe:${item.id}`, { ...info, type: 'probe', label: `Reading ${displayName(item)}` }, () => probeJob(item.id, key));
        continue;
      }
      if (!rec.thumbV && rec.thumbFailed !== key) {
        quick.add(`thumb:${item.id}`, { ...info, type: 'thumbnail', label: `Thumbnail for ${displayName(item)}` }, () => thumbJob(item.id, key));
      }
      if (rec.probe.textSubtitles?.length && rec.subsExtracted !== key && rec.probe.playable) {
        quick.add(`subs:${item.id}`, { ...info, type: 'subtitles', label: `Subtitles for ${displayName(item)}` }, (job, signal) => subtitleJob(item.id, key, signal));
      }
      if (!rec.probe.playable && !rec.probe.unreadable && (config.autoConvert || rec.convertRequested) && rec.convertFailed !== key) {
        heavy.add(`convert:${item.id}`, { ...info, type: 'convert', label: `Converting ${displayName(item)}` }, (job, signal) => convertJob(item.id, key, job, signal));
      }
      // A converted file's original can linger if it was open (Windows) when we tried to delete it.
      const source = rec.convertedSource;
      for (const dup of source ? item.duplicates : []) {
        if (!dup.toLowerCase().endsWith(`.${source.ext}`)) continue;
        fsp.stat(dup).then((st) => st.size === source.size && fsp.rm(dup, { force: true })).catch(() => {});
      }
    }
  }

  async function probeJob(id, key) {
    const item = library.get(id);
    if (!item) return;
    const rec = library.record(id);
    try {
      const info = await media.probe(item.abs);
      rec.probe = { key, duration: info.duration, textSubtitles: info.textSubtitles, ...planFor(info, item.ext) };
    } catch (err) {
      log(`Could not read ${item.rel}: ${err.message}`);
      rec.probe = { key, playable: BROWSER_PLAYABLE_EXTS.has(item.ext), reason: 'The file could not be read', unreadable: true };
      rec.thumbFailed = key;
    }
    db.save();
    schedule();
  }

  async function thumbJob(id, key) {
    const item = library.get(id);
    if (!item) return;
    const rec = library.record(id);
    const duration = rec.probe?.duration || 0;
    const dest = path.join(dirs.thumbs, `${id}.jpg`);
    const opts = { videoIndex: rec.probe?.videoIndex };
    try {
      await media.thumbnail(item.abs, dest, { ...opts, at: duration ? Math.min(duration * 0.15, 600) : 10 });
      if (!(await fsp.stat(dest).catch(() => null))) await media.thumbnail(item.abs, dest, { ...opts, at: 0 });
      rec.thumbV = Date.now();
    } catch (err) {
      log(`No thumbnail for ${item.rel}: ${err.message}`);
      rec.thumbFailed = key;
    }
    db.save();
  }

  async function subtitleJob(id, key, signal) {
    const item = library.get(id);
    const rec = library.record(id);
    const tracks = rec.probe?.textSubtitles ?? [];
    if (!item || !tracks.length) return;
    const dir = library.subtitleDir(id);
    await fsp.mkdir(dir, { recursive: true });
    const stamp = Date.now().toString(36);
    const targets = tracks.map((t, n) => ({ ...t, file: `embedded-${stamp}-${n}.vtt`, dest: path.join(dir, `embedded-${stamp}-${n}.vtt`) }));
    try {
      await media.extractSubtitles(item.abs, targets, signal);
      const index = (await library.readSubtitleIndex(id)).filter((t) => t.source !== 'embedded');
      for (const t of targets) index.push({ file: t.file, label: t.label, lang: t.lang, source: 'embedded' });
      await library.writeSubtitleIndex(id, index);
    } catch (err) {
      for (const t of targets) await fsp.rm(t.dest, { force: true });
      if (signal.aborted) throw err;
      log(`Could not extract subtitles from ${item.rel}: ${err.message}`);
    }
    rec.subsExtracted = key;
    db.save();
    await library.scan();
  }

  async function convertJob(id, key, job, signal) {
    const item = library.get(id);
    const rec = library.record(id);
    if (!item || !rec.probe || rec.probe.playable) return;
    const dir = path.dirname(item.abs);
    const base = stripExt(path.basename(item.abs));
    const tmp = path.join(dir, `.${base}${CONVERTING_SUFFIX}`);
    const dest = path.join(dir, `${base}.mp4`);
    try {
      const space = await freeSpace(dir);
      if (space && space.free < item.size * 1.1 + 512 * 1024 * 1024) throw new Error('Not enough free disk space to convert');
      // Converting drops embedded subtitles, so pull out the text ones first.
      if (rec.probe.textSubtitles?.length && rec.subsExtracted !== key) await subtitleJob(id, key, signal);
      log(`Converting ${item.rel} for phones (${rec.probe.reason})`);
      await media.convert(item.abs, tmp, rec.probe, {
        duration: rec.probe.duration,
        signal,
        onProgress: (p) => (job.progress = p),
      });
      await fsp.rename(tmp, dest);
      if (dest !== item.abs) {
        rec.convertedSource = { ext: item.ext, size: item.size };
        await fsp.rm(item.abs, { force: true }).catch((err) => log(`Could not remove ${item.rel}: ${err.message}`));
      }
      rec.probe = null;
      delete rec.convertRequested;
      delete rec.convertFailed;
      delete rec.convertError;
      log(`Converted ${item.rel}`);
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      if (signal.aborted) return;
      rec.convertFailed = key;
      rec.convertError = err.message;
      log(`Could not convert ${item.rel}: ${err.message}`);
    }
    db.save();
    await rescan();
  }

  // ---------------------------------------------------------------- API views

  function itemStatus(item) {
    const rec = db.data.items[item.id] ?? {};
    const plan = currentProbe(item);
    const running = heavy.current?.itemId === item.id ? heavy.current : null;
    if (running) return { status: 'converting', statusText: 'Converting so it plays on phones', jobProgress: running.progress };
    if (heavy.has(`convert:${item.id}`)) return { status: 'queued', statusText: 'Waiting to be converted for phones' };
    if (plan && !plan.playable && rec.convertFailed === fileKey(item)) return { status: 'failed', statusText: `Couldn't convert: ${rec.convertError}` };
    if (media.available && !plan) return { status: 'checking', statusText: 'Checking the file' };
    if (plan?.unreadable) return { status: 'unsupported', statusText: "The server couldn't read this file. It may be damaged or not fully downloaded." };
    if (plan?.playable) return { status: 'ready' };
    if (plan) return { status: 'needs-convert', statusText: plan.reason };
    if (BROWSER_PLAYABLE_EXTS.has(item.ext)) return { status: 'ready' };
    if (item.ext === 'mkv') return { status: 'limited', statusText: 'MKV files may not play on iPhone. Install ffmpeg on the server to convert them automatically.' };
    return { status: 'unsupported', statusText: `${item.ext.toUpperCase()} files usually don't play in browsers. Install ffmpeg on the server to convert them automatically.` };
  }

  function artUrl(key) {
    const rec = db.data.items[key] ?? db.data.shows[key];
    if (rec?.posterV) return `/api/art/${key}?v=${rec.posterV}`;
    if (rec?.thumbV) return `/api/art/${key}?v=t${rec.thumbV}`;
    return null;
  }

  function publicItem(item) {
    const rec = db.data.items[item.id] ?? {};
    const progress = db.data.progress[item.id] ?? null;
    return {
      id: item.id,
      kind: item.kind,
      title: item.title,
      year: item.year ?? null,
      show: item.show ?? null,
      showId: item.showId ?? null,
      season: item.season ?? null,
      episode: item.episode ?? null,
      fileName: item.name,
      ext: item.ext,
      size: item.size,
      addedAt: rec.addedAt ?? item.mtimeMs,
      duration: currentProbe(item)?.duration ?? progress?.duration ?? null,
      art: artUrl(item.id),
      hasCustomArt: Boolean(rec.posterV),
      token: auth.mediaToken(item.id),
      progress,
      subtitles: item.subtitles.map(({ id, label, lang, source }) => ({ id, label, lang, removable: source !== 'sidecar' })),
      ...itemStatus(item),
    };
  }

  function publicShow(show) {
    const firstWithArt = show.episodes.map((e) => artUrl(e.id)).find(Boolean);
    return {
      id: show.id,
      title: show.title,
      art: artUrl(show.id) ?? firstWithArt ?? null,
      hasCustomArt: Boolean(db.data.shows[show.id]?.posterV),
      addedAt: Math.max(...show.episodes.map((e) => db.data.items[e.id]?.addedAt ?? e.mtimeMs)),
      episodeIds: show.episodes.map((e) => e.id),
    };
  }

  const jobList = () => [...heavy.list(), ...quick.list()];

  async function freshLibrary() {
    if (Date.now() - library.scannedAt > RESCAN_AFTER_MS) await rescan();
    return library;
  }

  async function findItem(id) {
    let item = library.get(id);
    if (!item) item = (await rescan()).get(id);
    if (!item) throw new HttpError(404, 'That video is no longer in the library.');
    return item;
  }

  async function removeEmptyDirs(dir) {
    const stopAt = new Set([mediaDir, path.join(mediaDir, 'movies'), path.join(mediaDir, 'tv')].map((d) => path.resolve(d)));
    for (let d = path.resolve(dir); !stopAt.has(d) && d.startsWith(path.resolve(mediaDir)); d = path.dirname(d)) {
      try {
        await fsp.rmdir(d);
      } catch {
        return;
      }
    }
  }

  async function deleteItem(item) {
    quick.cancel(item.id);
    heavy.cancel(item.id);
    for (const file of [item.abs, ...item.duplicates, ...item.subtitles.filter((s) => s.source === 'sidecar').map((s) => s.path)]) {
      await fsp.rm(file, { force: true });
    }
    await fsp.rm(library.subtitleDir(item.id), { recursive: true, force: true });
    await fsp.rm(path.join(dirs.thumbs, `${item.id}.jpg`), { force: true });
    await fsp.rm(path.join(dirs.posters, `${item.id}.jpg`), { force: true });
    delete db.data.items[item.id];
    delete db.data.progress[item.id];
    for (const sub of item.subtitles.filter((s) => s.source === 'sidecar')) await removeEmptyDirs(path.dirname(sub.path));
    await removeEmptyDirs(path.dirname(item.abs));
    log(`Deleted ${item.rel}`);
  }

  function setWatched(item, watched) {
    if (!watched) {
      delete db.data.progress[item.id];
      return;
    }
    const duration = db.data.items[item.id]?.probe?.duration ?? db.data.progress[item.id]?.duration ?? 0;
    db.data.progress[item.id] = { position: duration, duration, watched: true, updatedAt: Date.now() };
  }

  // ---------------------------------------------------------------- routes

  const router = new Router();
  const route = (method, pattern, handler, options) => router.add(method, pattern, handler, options);
  const PUBLIC = { public: true };

  route('GET', '/api/session', (req) => ({
    authenticated: auth.isAuthenticated(req),
    configured: auth.configured,
    canSetup: !auth.configured && !isProxied(req) && isPrivateAddress(clientAddress(req)),
  }), PUBLIC);

  route('POST', '/api/setup', async (req, res) => {
    if (auth.configured) throw new HttpError(409, 'A password has already been set.');
    if (isProxied(req) || !isPrivateAddress(clientAddress(req))) {
      throw new HttpError(403, 'Create the password from a device on your home network first.');
    }
    const { password } = await readJson(req);
    if (String(password ?? '').length < 6) throw new HttpError(400, 'Use at least 6 characters.');
    await auth.setPassword(String(password));
    log('Password created');
    res.setHeader('Set-Cookie', auth.sessionCookie(req));
    return { ok: true };
  }, PUBLIC);

  route('POST', '/api/login', async (req, res) => {
    const ip = clientAddress(req);
    if (auth.isRateLimited(ip)) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    const { password } = await readJson(req);
    if (!(await auth.check(String(password ?? '')))) {
      auth.recordFailure(ip);
      throw new HttpError(401, 'Wrong password.');
    }
    auth.clearFailures(ip);
    res.setHeader('Set-Cookie', auth.sessionCookie(req));
    return { ok: true };
  }, PUBLIC);

  route('POST', '/api/logout', (req, res) => {
    res.setHeader('Set-Cookie', auth.clearCookie(req));
    return { ok: true };
  }, PUBLIC);

  route('POST', '/api/password', async (req, res) => {
    if (config.password) throw new HttpError(409, 'The password is set by MOVIES_PASSWORD on the server. Change it there.');
    const { current, next } = await readJson(req);
    if (!(await auth.check(String(current ?? '')))) throw new HttpError(400, 'Your current password is wrong.');
    if (String(next ?? '').length < 6) throw new HttpError(400, 'Use at least 6 characters.');
    await auth.setPassword(String(next));
    res.setHeader('Set-Cookie', auth.sessionCookie(req));
    return { ok: true };
  });

  route('GET', '/api/library', async () => {
    await freshLibrary();
    return {
      items: [...library.items.values()].map(publicItem),
      shows: [...library.shows.values()].map(publicShow),
      jobs: jobList(),
      ffmpeg: media.available,
    };
  });

  route('POST', '/api/rescan', async () => {
    await rescan();
    return { items: library.items.size };
  });

  route('GET', '/api/jobs', () => ({ jobs: jobList() }));

  route('GET', '/api/info', async (req) => {
    const space = await freeSpace(mediaDir);
    const pkg = JSON.parse(await fsp.readFile(path.join(config.publicDir, '..', 'package.json'), 'utf8'));
    return {
      version: pkg.version,
      urls: config.publicUrl ? [{ url: config.publicUrl, label: 'configured' }] : networkUrls(config.port),
      mediaDir,
      space,
      ffmpeg: media.available,
      ffmpegDisabled: !config.useFfmpeg,
      autoConvert: config.autoConvert,
      passwordFromEnv: Boolean(config.password),
      viaNetwork: !clientAddress(req).match(/^(127\.|::1$)/),
    };
  });

  const MEDIA = { media: true };

  route('GET', '/api/stream/:id', async (req, res, { id }) => {
    let item = await findItem(id);
    let st = await fsp.stat(item.abs).catch(() => null);
    if (!st) {
      // The file may have just been swapped for a converted copy.
      item = await findItem(id);
      st = await fsp.stat(item.abs).catch(() => null);
      if (!st) throw new HttpError(404, 'That video file is missing.');
    }
    await sendFile(req, res, item.abs, { type: VIDEO_TYPES[item.ext] ?? 'application/octet-stream', size: st.size });
  }, MEDIA);

  route('GET', '/api/subtitles/:id/:subId', async (req, res, { id, subId }) => {
    const item = await findItem(id);
    const sub = item.subtitles.find((s) => s.id === subId.replace(/\.vtt$/, ''));
    if (!sub) throw new HttpError(404, 'Subtitle track not found.');
    const text = decodeText(await fsp.readFile(sub.path));
    const vtt = sub.format === 'srt' ? srtToVtt(text) : text;
    res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'private, no-cache' });
    res.end(vtt);
  }, MEDIA);

  route('POST', '/api/items/:id/subtitles', async (req, res, { id }, url) => {
    await findItem(id);
    const text = decodeText(await readBody(req, 5 * 1024 * 1024)).trim();
    if (!/-->/.test(text)) throw new HttpError(400, "That doesn't look like an .srt or .vtt subtitle file.");
    const guess = subtitleFileLabel(url.searchParams.get('filename') ?? '');
    const label = url.searchParams.get('label')?.trim().slice(0, 60) || guess.label;
    await library.addSubtitle(id, { label, lang: guess.lang, vtt: srtToVtt(text), source: 'uploaded' });
    await library.scan();
    return publicItem(library.get(id));
  });

  route('DELETE', '/api/items/:id/subtitles/:subId', async (req, res, { id, subId }) => {
    const item = await findItem(id);
    const sub = item.subtitles.find((s) => s.id === subId);
    if (!sub || sub.source === 'sidecar') throw new HttpError(404, 'Subtitle track not found.');
    const index = (await library.readSubtitleIndex(id)).filter((t) => t.file !== sub.file);
    await library.writeSubtitleIndex(id, index);
    await fsp.rm(sub.path, { force: true });
    await library.scan();
    return publicItem(library.get(id));
  });

  route('GET', '/api/art/:key', async (req, res, { key }) => {
    if (!ART_KEY.test(key)) throw new HttpError(404, 'Not found.');
    for (const file of [path.join(dirs.posters, `${key}.jpg`), path.join(dirs.thumbs, `${key}.jpg`)]) {
      const st = await fsp.stat(file).catch(() => null);
      if (st) return sendFile(req, res, file, { type: 'image/jpeg', size: st.size, cache: 'private, max-age=31536000, immutable' });
    }
    throw new HttpError(404, 'No artwork.');
  });

  route('PUT', '/api/art/:key', async (req, res, { key }) => {
    const isShow = library.shows.has(key);
    if (!ART_KEY.test(key) || (!isShow && !library.get(key))) throw new HttpError(404, 'Not found.');
    const buf = await readBody(req, MAX_IMAGE);
    if (!isJpeg(buf)) throw new HttpError(400, 'Send the picture as a JPEG.');
    await fsp.writeFile(path.join(dirs.posters, `${key}.jpg`), buf);
    const rec = isShow ? (db.data.shows[key] ??= {}) : library.record(key);
    rec.posterV = Date.now();
    db.save();
    return { art: artUrl(key) };
  });

  route('DELETE', '/api/art/:key', async (req, res, { key }) => {
    if (!ART_KEY.test(key)) throw new HttpError(404, 'Not found.');
    await fsp.rm(path.join(dirs.posters, `${key}.jpg`), { force: true });
    const rec = db.data.shows[key] ?? db.data.items[key];
    if (rec) delete rec.posterV;
    db.save();
    return { ok: true };
  });

  // Browsers capture a frame themselves when the server has no ffmpeg.
  route('PUT', '/api/items/:id/thumb', async (req, res, { id }) => {
    await findItem(id);
    const rec = library.record(id);
    if (rec.thumbV) return { art: artUrl(id) };
    const buf = await readBody(req, MAX_IMAGE);
    if (!isJpeg(buf)) throw new HttpError(400, 'Send the picture as a JPEG.');
    await fsp.writeFile(path.join(dirs.thumbs, `${id}.jpg`), buf);
    rec.thumbV = Date.now();
    db.save();
    return { art: artUrl(id) };
  });

  route('POST', '/api/progress/:id', async (req, res, { id }) => {
    const body = await readJson(req);
    await findItem(id);
    const position = Number(body.position);
    const duration = Number(body.duration) || db.data.items[id]?.probe?.duration || 0;
    if (!Number.isFinite(position) || position < 0 || !Number.isFinite(duration)) throw new HttpError(400, 'Invalid position.');
    const progress = { position: Math.min(position, duration || position), duration, watched: isWatched(position, duration), updatedAt: Date.now() };
    db.data.progress[id] = progress;
    db.save();
    return progress;
  });

  route('POST', '/api/items/:id/watched', async (req, res, { id }) => {
    const item = await findItem(id);
    setWatched(item, Boolean((await readJson(req)).watched));
    db.save();
    return publicItem(item);
  });

  route('PATCH', '/api/items/:id', async (req, res, { id }) => {
    const item = await findItem(id);
    const body = await readJson(req);
    const rec = library.record(id);
    const meta = (rec.meta ??= {});
    const text = (v) => String(v ?? '').trim().slice(0, 200);
    const num = (v, max) => (v === '' || v == null ? null : Number.isInteger(Number(v)) && v >= 0 && v <= max ? Number(v) : undefined);
    if ('title' in body) meta.title = text(body.title);
    if (item.kind === 'movie' && 'year' in body) {
      const year = num(body.year, 2100);
      if (year === undefined) throw new HttpError(400, 'Invalid year.');
      meta.year = year;
    }
    if (item.kind === 'movie' && 'title' in body && !meta.title) throw new HttpError(400, 'Enter a title.');
    if (item.kind === 'episode') {
      if ('show' in body) {
        if (!text(body.show)) throw new HttpError(400, 'Enter the show name.');
        meta.show = text(body.show);
      }
      for (const key of ['season', 'episode']) {
        if (!(key in body)) continue;
        const n = num(body[key], 9999);
        if (n === undefined || (key === 'season' && n === null)) throw new HttpError(400, `Invalid ${key} number.`);
        meta[key] = n;
      }
    }
    db.save();
    await library.scan();
    return publicItem(library.get(id));
  });

  route('DELETE', '/api/items/:id', async (req, res, { id }) => {
    await deleteItem(await findItem(id));
    db.save();
    await rescan();
    return { ok: true };
  });

  route('POST', '/api/items/:id/convert', async (req, res, { id }) => {
    const item = await findItem(id);
    if (!media.available) throw new HttpError(409, 'ffmpeg is not installed on the server.');
    const rec = library.record(id);
    delete rec.convertFailed;
    delete rec.convertError;
    rec.convertRequested = true;
    rec.probe = null; // re-check the file first, then convert if it still needs it
    db.save();
    schedule();
    return publicItem(item);
  });

  route('PATCH', '/api/shows/:id', async (req, res, { id }) => {
    const show = library.shows.get(id);
    if (!show) throw new HttpError(404, 'Show not found.');
    const title = String((await readJson(req)).title ?? '').trim().slice(0, 200);
    if (!title) throw new HttpError(400, 'Enter the show name.');
    for (const ep of show.episodes) (library.record(ep.id).meta ??= {}).show = title;
    const newId = (await library.scan()).get(show.episodes[0].id).showId;
    if (newId !== id && db.data.shows[id]) {
      db.data.shows[newId] = { ...db.data.shows[id], title: undefined };
      delete db.data.shows[id];
      const poster = path.join(dirs.posters, `${id}.jpg`);
      await fsp.rename(poster, path.join(dirs.posters, `${newId}.jpg`)).catch(() => {});
    }
    db.save();
    await library.scan();
    return { id: newId };
  });

  route('DELETE', '/api/shows/:id', async (req, res, { id }) => {
    const show = library.shows.get(id);
    if (!show) throw new HttpError(404, 'Show not found.');
    for (const ep of show.episodes) await deleteItem(ep);
    delete db.data.shows[id];
    await fsp.rm(path.join(dirs.posters, `${id}.jpg`), { force: true });
    db.save();
    await rescan();
    return { ok: true };
  });

  route('POST', '/api/shows/:id/watched', async (req, res, { id }) => {
    const show = library.shows.get(id);
    if (!show) throw new HttpError(404, 'Show not found.');
    const { watched, season } = await readJson(req);
    for (const ep of show.episodes) if (season == null || ep.season === season) setWatched(ep, Boolean(watched));
    db.save();
    return { ok: true };
  });

  route('POST', '/api/uploads', async (req) => uploads.create(await readJson(req)));
  route('GET', '/api/uploads/:uploadId', (req, res, { uploadId }) => uploads.status(uploadId));
  route('DELETE', '/api/uploads/:uploadId', async (req, res, { uploadId }) => (await uploads.cancel(uploadId), { ok: true }));

  route('PUT', '/api/uploads/:uploadId', async (req, res, { uploadId }, url) => {
    const result = await uploads.writeChunk(uploadId, Number(url.searchParams.get('offset')), req);
    if (result.conflict) {
      req.resume();
      sendJson(res, 409, { error: 'Out of sync', offset: result.offset });
      return;
    }
    return result;
  });

  route('POST', '/api/uploads/:uploadId/complete', async (req, res, { uploadId }) => {
    const { rel, fields } = await uploads.complete(uploadId);
    const id = (await library.scan(), [...library.items.values()].find((i) => i.rel === rel)?.id);
    if (!id) throw new HttpError(500, 'The file was saved but could not be added to the library.');
    // Keep exactly what was typed; file names can't hold every character.
    const rec = library.record(id);
    rec.addedAt = Date.now();
    rec.meta = fields.kind === 'movie'
      ? { title: fields.title || undefined, year: fields.title ? fields.year : undefined }
      : { show: fields.show, season: fields.season ?? undefined, episode: fields.episode ?? undefined, title: fields.title || undefined };
    db.save();
    await rescan();
    log(`Uploaded ${rel}`);
    return publicItem(library.get(id));
  });

  // ---------------------------------------------------------------- static files

  async function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const file = path.resolve(config.publicDir, rel);
    if (!file.startsWith(config.publicDir + path.sep)) throw new HttpError(404, 'Not found.');
    const st = await fsp.stat(file).catch(() => null);
    if (!st?.isFile()) throw new HttpError(404, 'Not found.');
    const etag = `"${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}"`;
    const headers = { ETag: etag, 'Cache-Control': 'no-cache' };
    if (file.endsWith('.html')) headers['Content-Security-Policy'] = CSP;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(200, { ...headers, 'Content-Type': STATIC_TYPES[path.extname(file)] ?? 'application/octet-stream', 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  async function handle(req, res) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
        return await serveStatic(req, res, url.pathname);
      }
      const match = router.match(req.method, url.pathname);
      if (!match) throw new HttpError(404, 'Not found.');
      if (match.notAllowed) throw new HttpError(405, 'Method not allowed.');
      const allowed = match.options.public || auth.isAuthenticated(req) ||
        (match.options.media && auth.checkMediaToken(match.params.id, url.searchParams.get('t')));
      if (!allowed) throw new HttpError(401, 'Please log in.');
      const result = await match.handler(req, res, match.params, url);
      if (result !== undefined && !res.headersSent) sendJson(res, 200, result);
    } catch (err) {
      const status = err.status ?? 500;
      if (status === 500) log(`${req.method} ${url.pathname}: ${err.stack || err.message}`);
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Something went wrong on the server.' : err.message });
      else res.destroy();
      if (req.readable) req.resume();
    }
  }

  const server = http.createServer(handle);
  server.requestTimeout = 0; // a slow phone upload can take longer than Node's 5-minute default
  server.keepAliveTimeout = 65_000;

  await library.scan();
  for (const leftover of library.leftovers) await fsp.rm(leftover, { force: true });
  schedule();
  const timer = setInterval(() => rescan().catch((err) => log(`Rescan failed: ${err.message}`)), 5 * 60_000);
  timer.unref();

  return {
    server,
    library,
    db,
    media,
    auth,
    jobs: { quick, heavy },
    rescan,
    async idle() {
      while (quick.current || quick.queue.length || heavy.current || heavy.queue.length) {
        await Promise.all([quick.idle(), heavy.idle()]);
      }
    },
    async close() {
      clearInterval(timer);
      quick.queue = [];
      heavy.queue = [];
      quick.current?.controller.abort();
      heavy.current?.controller.abort();
      db.flush();
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
    },
  };
}
