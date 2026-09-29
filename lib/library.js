import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { extname, isSubtitle, isVideo, parseName, seasonFromFolder, stripExt, tidy } from '../public/js/parse.js';
import { languageFromLabel } from './languages.js';

const MOVIE_DIRS = new Set(['movies', 'movie', 'films']);
const TV_DIRS = new Set(['tv', 'tv shows', 'shows', 'series']);
const IGNORED_DIRS = new Set(['@eadir', '$recycle.bin', 'system volume information', 'lost+found', 'node_modules']);
const SUB_DIRS = new Set(['subs', 'subtitles']);
const SAMPLE = /(^|[\s._-])sample([\s._-]|$)/i;
export const CONVERTING_SUFFIX = '.converting.mp4';
const EXT_PREFERENCE = ['mp4', 'm4v', 'mov', 'webm', 'mkv'];
const extRank = (ext) => (EXT_PREFERENCE.includes(ext) ? EXT_PREFERENCE.indexOf(ext) : EXT_PREFERENCE.length);

export const hashId = (s, n = 16) => crypto.createHash('sha1').update(s).digest('hex').slice(0, n);
export const showIdFor = (title) => 's' + hashId(title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''), 11);

async function walk(dir, rel, depth, found) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.name.startsWith('.') && e.name.endsWith(CONVERTING_SUFFIX)) found.leftovers.push(abs);
    if (e.name.startsWith('.') || IGNORED_DIRS.has(e.name.toLowerCase())) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    let isDir = e.isDirectory();
    let isFile = e.isFile();
    if (e.isSymbolicLink()) {
      const st = await fsp.stat(abs).catch(() => null);
      isDir = Boolean(st?.isDirectory());
      isFile = Boolean(st?.isFile());
    }
    if (isDir && depth < 8) await walk(abs, r, depth + 1, found);
    else if (isFile && isVideo(e.name) && !SAMPLE.test(stripExt(e.name))) found.videos.push({ abs, rel: r, dir: rel, name: e.name });
    else if (isFile && isSubtitle(e.name)) found.subs.push({ abs, rel: r, dir: rel, name: e.name });
  }
}

// "Breaking.Bad.S01.1080p" or "Breaking Bad (2008)" -> "Breaking Bad"
function showFromFolder(name) {
  return tidy(parseName(name).title.replace(/\b(?:s\d{1,2}|season \d{1,2}|complete|series)\b.*$/i, ''));
}

export function subtitleLabel(raw) {
  const cleaned = raw.replace(/^[\s._-]+/, '').replace(/^\d+_/, '').replace(/[._]+/g, ' ').trim();
  const lang = languageFromLabel(cleaned);
  let label = cleaned || 'Subtitles';
  if (lang && cleaned.toLowerCase() === lang.lang) label = lang.name;
  else if (lang && /^[a-z]{2,3}(\s|$)/i.test(cleaned) && cleaned.split(' ')[0].length <= 3) {
    label = [lang.name, ...cleaned.split(' ').slice(1)].join(' ');
  }
  return { label: label.replace(/\b\w/g, (c) => c.toUpperCase()), lang: lang?.lang ?? '' };
}

/** Labels an uploaded subtitle file from the end of its name: "Movie.en.srt" -> English. */
export function subtitleFileLabel(filename) {
  const tail = stripExt(filename).split(/[._\s-]+/).slice(-2).join(' ');
  const lang = languageFromLabel(tail);
  if (!lang) return { label: 'Subtitles', lang: '' };
  const extra = /\bforced\b/i.test(tail) ? ' (Forced)' : /\b(sdh|cc|hi)\b/i.test(tail) ? ' (SDH)' : '';
  return { label: lang.name + extra, lang: lang.lang };
}

/**
 * The library is whatever video files are in the media folder. Anything under movies/ is
 * a movie, anything under tv/<Show>/ is an episode, and files elsewhere are sorted by name.
 * Per-file extras (edits, probe results, progress) live in the JSON database, keyed by an
 * id derived from the file path without its extension, so converting .mkv to .mp4 keeps it.
 */
export class Library {
  constructor({ mediaDir, dataDir, db }) {
    this.mediaDir = mediaDir;
    this.dataDir = dataDir;
    this.db = db;
    this.items = new Map();
    this.shows = new Map();
    this.scanning = null;
    this.scannedAt = 0;
  }

  get(id) {
    return this.items.get(id);
  }

  record(id) {
    return (this.db.data.items[id] ??= {});
  }

  scan() {
    this.scanning ??= this.#scan().finally(() => (this.scanning = null));
    return this.scanning;
  }

  async #scan() {
    const found = { videos: [], subs: [], leftovers: [] };
    await walk(this.mediaDir, '', 0, found);
    const firstScan = Object.keys(this.db.data.items).length === 0;

    const items = new Map();
    for (const v of found.videos) {
      const st = await fsp.stat(v.abs).catch(() => null);
      if (!st) continue;
      const file = { ...v, ext: extname(v.name), size: st.size, mtimeMs: Math.round(st.mtimeMs), duplicates: [] };
      file.id = hashId(stripExt(v.rel));
      const existing = items.get(file.id);
      if (existing && extRank(existing.ext) <= extRank(file.ext)) {
        existing.duplicates.push(file.abs);
        continue;
      }
      if (existing) file.duplicates = [existing.abs, ...existing.duplicates];
      items.set(file.id, file);
    }

    for (const item of items.values()) {
      this.#describe(item);
      const rec = this.record(item.id);
      rec.addedAt ??= firstScan ? item.mtimeMs : Date.now();
    }
    await this.#attachSubtitles(items, found.subs);

    const shows = new Map();
    for (const item of items.values()) {
      if (item.kind !== 'episode') continue;
      let show = shows.get(item.showId);
      if (!show) shows.set(item.showId, (show = { id: item.showId, title: item.show, episodes: [] }));
      show.episodes.push(item);
    }
    for (const show of shows.values()) {
      show.episodes.sort((a, b) => a.season - b.season || (a.episode ?? 1e9) - (b.episode ?? 1e9) || a.name.localeCompare(b.name));
    }

    this.items = items;
    this.shows = shows;
    this.scannedAt = Date.now();
    this.leftovers = found.leftovers;
    this.db.save();
    return this;
  }

  #describe(item) {
    const segs = item.rel.split('/');
    const top = segs.length > 1 ? segs[0].toLowerCase() : '';
    let kind = MOVIE_DIRS.has(top) ? 'movie' : TV_DIRS.has(top) ? 'episode' : null;
    const parsed = parseName(item.name, { tv: kind === 'episode' });
    kind ??= parsed.kind;
    const meta = this.db.data.items[item.id]?.meta ?? {};
    item.kind = kind;

    if (kind === 'movie') {
      let { title, year } = parsed;
      // "movies/Inception (2010)/inception-1080p.mkv": the folder name is often cleaner
      if (segs.length >= 3 && !year) {
        const folder = parseName(segs.at(-2));
        if (folder.year) ({ title, year } = folder);
      }
      item.title = meta.title ?? title;
      item.year = meta.year !== undefined ? meta.year : year;
      return;
    }

    let show = parsed.show;
    if (TV_DIRS.has(top) && segs.length >= 3) show = showFromFolder(segs[1]) || show;
    let folderSeason = null;
    for (const seg of segs.slice(0, -1)) folderSeason = seasonFromFolder(seg) ?? folderSeason;
    item.show = meta.show || show || 'Unsorted episodes';
    item.showId = showIdFor(item.show);
    item.season = meta.season ?? parsed.season ?? folderSeason ?? 1;
    item.episode = meta.episode !== undefined ? meta.episode : parsed.episode;
    item.title = meta.title ?? parsed.title;
  }

  async #attachSubtitles(items, subs) {
    const videosByDir = new Map();
    for (const item of items.values()) {
      item.subtitles = [];
      videosByDir.set(item.dir, [...(videosByDir.get(item.dir) ?? []), item]);
    }
    // Sidecar files: "Movie.srt", "Movie.en.srt", or a Subs/ folder next to a lone video.
    for (const sub of subs) {
      const subBase = stripExt(sub.name);
      const siblings = videosByDir.get(sub.dir) ?? [];
      let owner = siblings
        .filter((v) => subBase.toLowerCase().startsWith(stripExt(v.name).toLowerCase()))
        .sort((a, b) => b.name.length - a.name.length)[0];
      const raw = owner ? subBase.slice(stripExt(owner.name).length) : subBase;
      if (!owner) {
        const parts = sub.dir.split('/');
        const subsAt = parts.findIndex((p) => SUB_DIRS.has(p.toLowerCase()));
        const parentDir = subsAt >= 0 ? parts.slice(0, subsAt).join('/') : sub.dir;
        const candidates = videosByDir.get(parentDir) ?? [];
        if (candidates.length === 1) owner = candidates[0];
      }
      if (!owner) continue;
      const { label, lang } = subtitleLabel(raw);
      owner.subtitles.push({ id: hashId(sub.rel, 10), label, lang, path: sub.abs, format: extname(sub.name), source: 'sidecar' });
    }
    // Uploaded or extracted tracks, stored as WebVTT in data/subs/<id>/.
    for (const item of items.values()) {
      const index = await this.readSubtitleIndex(item.id);
      for (const t of index) {
        item.subtitles.push({
          id: hashId(`${item.id}/${t.file}`, 10), label: t.label, lang: t.lang, file: t.file,
          path: path.join(this.subtitleDir(item.id), t.file), format: 'vtt', source: t.source,
        });
      }
      item.subtitles.sort((a, b) => a.label.localeCompare(b.label));
    }
  }

  subtitleDir(id) {
    return path.join(this.dataDir, 'subs', id);
  }

  async readSubtitleIndex(id) {
    try {
      return JSON.parse(await fsp.readFile(path.join(this.subtitleDir(id), 'index.json'), 'utf8'));
    } catch {
      return [];
    }
  }

  async writeSubtitleIndex(id, index) {
    await fsp.mkdir(this.subtitleDir(id), { recursive: true });
    await fsp.writeFile(path.join(this.subtitleDir(id), 'index.json'), JSON.stringify(index, null, 1));
  }

  async addSubtitle(id, { label, lang, vtt, source }) {
    const index = await this.readSubtitleIndex(id);
    const file = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.vtt`;
    await fsp.mkdir(this.subtitleDir(id), { recursive: true });
    await fsp.writeFile(path.join(this.subtitleDir(id), file), vtt);
    index.push({ file, label, lang, source });
    await this.writeSubtitleIndex(id, index);
  }
}
