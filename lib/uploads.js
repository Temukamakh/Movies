import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { extname, isVideo, stripExt } from '../public/js/parse.js';
import { HttpError } from './http.js';
import { hashId } from './library.js';

const MAX_CHUNK = 128 * 1024 * 1024;
const STALE_MS = 7 * 864e5;
const ID = /^[a-f0-9]{20}$/;

const fileSize = (p) => fsp.stat(p).then((s) => s.size, () => 0);

export async function freeSpace(dir) {
  try {
    const s = await fsp.statfs(dir);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

/** Makes a string safe to use as a file or folder name on Windows, macOS and Linux. */
export function safeName(value) {
  let s = String(value ?? '')
    .replace(/:/g, ' -')
    .replace(/[\\/*?"<>|\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 120)
    .trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s += '_';
  return s;
}

const int = (v, min, max) => {
  const n = Number(v);
  return v !== '' && v != null && Number.isInteger(n) && n >= min && n <= max ? n : null;
};

/** Validates what the upload form sent about a file. */
export function cleanFields(body) {
  const kind = body.kind === 'episode' ? 'episode' : 'movie';
  if (kind === 'movie') {
    const title = String(body.title ?? '').trim().slice(0, 200);
    return { kind, title, year: int(body.year, 1870, 2100) };
  }
  const show = String(body.show ?? '').trim().slice(0, 200);
  if (!safeName(show)) throw new HttpError(400, 'Enter the name of the TV show.');
  return {
    kind,
    show,
    season: int(body.season, 0, 999),
    episode: int(body.episode, 0, 9999),
    title: String(body.title ?? '').trim().slice(0, 200),
  };
}

/** Where an uploaded file goes inside the media folder, e.g. "tv/Show/Season 1/Show - S01E02.mkv". */
export function destinationFor(filename, f) {
  const ext = extname(filename);
  const pad = (n) => String(n).padStart(2, '0');
  if (f.kind === 'episode') {
    const show = safeName(f.show);
    const seasonDir = f.season != null ? `Season ${f.season}` : '';
    if (f.season != null && f.episode != null) {
      const title = safeName(f.title);
      return path.join('tv', show, seasonDir, `${show} - S${pad(f.season)}E${pad(f.episode)}${title ? ` - ${title}` : ''}.${ext}`);
    }
    return path.join('tv', show, seasonDir, `${safeName(stripExt(filename)) || 'Episode'}.${ext}`);
  }
  const title = safeName(f.title) || safeName(stripExt(filename)) || 'Movie';
  return path.join('movies', `${title}${f.year ? ` (${f.year})` : ''}.${ext}`);
}

async function uniquePath(p) {
  const { dir, name, ext } = path.parse(p);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? p : path.join(dir, `${name} (${n})${ext}`);
    if (!(await fsp.stat(candidate).catch(() => null))) return candidate;
  }
}

async function move(from, to) {
  try {
    await fsp.rename(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fsp.copyFile(from, to);
    await fsp.rm(from, { force: true });
  }
}

/**
 * Resumable chunked uploads. The browser sends a movie in slices (small enough for
 * tunnels like Cloudflare's 100 MB limit); if the connection drops, it asks where the
 * server got to and carries on from there.
 */
export class Uploads {
  constructor({ dataDir, mediaDir }) {
    this.dir = path.join(dataDir, 'uploads');
    this.mediaDir = mediaDir;
    this.busy = new Set();
  }

  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
    for (const name of await fsp.readdir(this.dir)) {
      const p = path.join(this.dir, name);
      const st = await fsp.stat(p).catch(() => null);
      if (st && Date.now() - st.mtimeMs > STALE_MS) await fsp.rm(p, { force: true });
    }
  }

  paths(id) {
    if (!ID.test(id)) throw new HttpError(404, 'Unknown upload.');
    return { part: path.join(this.dir, `${id}.part`), meta: path.join(this.dir, `${id}.json`) };
  }

  async readMeta(id) {
    try {
      return JSON.parse(await fsp.readFile(this.paths(id).meta, 'utf8'));
    } catch {
      throw new HttpError(404, 'This upload has expired. Please start it again.');
    }
  }

  async create(body) {
    const filename = path.basename(String(body.filename ?? ''));
    const size = Number(body.size);
    if (!isVideo(filename)) throw new HttpError(400, `${filename || 'That file'} doesn't look like a video.`);
    if (!Number.isSafeInteger(size) || size <= 0) throw new HttpError(400, 'Invalid file size.');
    const fields = cleanFields(body);
    const id = hashId(`${body.key || filename}|${size}`, 20);
    const { part, meta } = this.paths(id);
    const offset = Math.min(await fileSize(part), size);
    const space = await freeSpace(this.mediaDir);
    if (space && space.free < size - offset + 256 * 1024 * 1024) {
      throw new HttpError(507, 'Not enough free space on the server for this file.');
    }
    await fsp.writeFile(meta, JSON.stringify({ filename, size, fields, createdAt: Date.now() }));
    return { uploadId: id, offset };
  }

  async status(id) {
    const meta = await this.readMeta(id);
    return { offset: await fileSize(this.paths(id).part), size: meta.size };
  }

  /** Appends one slice. Returns the new offset, or the current one if the client is out of sync. */
  async writeChunk(id, offset, req) {
    const { part } = this.paths(id);
    const meta = await this.readMeta(id);
    if (this.busy.has(id)) return { offset: await fileSize(part), conflict: true };
    const current = await fileSize(part);
    if (offset !== current) return { offset: current, conflict: true };
    const length = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(length) || length <= 0) throw new HttpError(411, 'Missing Content-Length.');
    if (length > MAX_CHUNK) throw new HttpError(413, 'Chunk too large.');
    if (current + length > meta.size) throw new HttpError(400, 'Chunk goes past the end of the file.');
    this.busy.add(id);
    try {
      await pipeline(req, fs.createWriteStream(part, { flags: 'a' }));
    } finally {
      this.busy.delete(id);
    }
    return { offset: await fileSize(part) };
  }

  /** Moves the finished file into the library and returns its path relative to the media folder. */
  async complete(id) {
    const { part, meta: metaPath } = this.paths(id);
    const meta = await this.readMeta(id);
    const size = await fileSize(part);
    if (size !== meta.size) throw new HttpError(409, `Upload incomplete (${size} of ${meta.size} bytes).`);
    const dest = await uniquePath(path.join(this.mediaDir, destinationFor(meta.filename, meta.fields)));
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await move(part, dest);
    await fsp.rm(metaPath, { force: true });
    return { rel: path.relative(this.mediaDir, dest).split(path.sep).join('/'), fields: meta.fields };
  }

  async cancel(id) {
    const { part, meta } = this.paths(id);
    if (this.busy.has(id)) throw new HttpError(409, 'Upload still in progress.');
    await fsp.rm(part, { force: true });
    await fsp.rm(meta, { force: true });
  }
}
