import { api, cachedLibrary, getLibrary, invalidate } from './api.js';
import { isSubtitle, isVideo, parseName, seasonFromFolder, stripExt, tidy } from './parse.js';
import { bytes, captureFrame, duration, h, icon, pickFiles, toast } from './ui.js';

const CHUNK = 16 * 1024 * 1024;
const MAX_RETRIES = 8;
const ACTIVE = new Set(['queued', 'uploading', 'finishing']);

const entries = [];
const listeners = new Set();
let nextId = 1;
let emitQueued = false;

function emit() {
  if (emitQueued) return;
  emitQueued = true;
  requestAnimationFrame(() => {
    emitQueued = false;
    listeners.forEach((fn) => fn());
  });
}

export const uploads = {
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  active: () => entries.filter((e) => ACTIVE.has(e.state)),
  /** Overall progress of the current batch, 0..1 */
  progress() {
    const batch = entries.filter((e) => e.state !== 'pending');
    const total = batch.reduce((n, e) => n + e.file.size, 0);
    return total ? batch.reduce((n, e) => n + (e.state === 'done' ? e.file.size : e.loaded), 0) / total : 0;
  },
};

window.addEventListener('beforeunload', (e) => {
  if (uploads.active().length) {
    e.preventDefault();
    e.returnValue = '';
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- adding files

/** Guesses movie vs. episode, title, show and numbers from the file name and folders. */
function guessFields(file) {
  const path = file.relativePath || file.webkitRelativePath || file.name;
  const folders = path.split('/').slice(0, -1);
  const folderSeason = folders.map(seasonFromFolder).filter((n) => n != null).at(-1) ?? null;
  const tvHint = folderSeason != null;
  const p = parseName(file.name, { tv: tvHint });
  if (p.kind === 'episode') {
    const showFolder = folders.find((f) => seasonFromFolder(f) == null);
    const show = p.show || (showFolder ? tidy(parseName(showFolder).title.replace(/\b(?:s\d{1,2}|season \d{1,2}|complete)\b.*$/i, '')) : '');
    return { kind: 'episode', show, season: p.season ?? folderSeason ?? 1, episode: p.episode, title: p.title };
  }
  if (!p.year && folders.length) {
    const folder = parseName(folders.at(-1));
    if (folder.year) return { kind: 'movie', title: folder.title, year: folder.year };
  }
  return { kind: 'movie', title: p.title, year: p.year };
}

export function addFiles(files) {
  const videos = files.filter((f) => isVideo(f.name));
  const subs = files.filter((f) => isSubtitle(f.name));
  const others = files.length - videos.length - subs.length;
  const added = [];
  for (const file of videos) {
    const dupe = entries.find((e) => e.file.name === file.name && e.file.size === file.size && e.state !== 'error');
    if (dupe) continue;
    const entry = { id: nextId++, file, fields: guessFields(file), subs: [], state: 'pending', loaded: 0, speed: 0, samples: [] };
    entries.push(entry);
    added.push(entry);
  }
  const unmatched = [];
  for (const sub of subs) {
    const base = stripExt(sub.name).toLowerCase();
    const owner = added.find((e) => base.startsWith(stripExt(e.file.name).toLowerCase())) ?? (added.length === 1 ? added[0] : null);
    if (owner) owner.subs.push(sub);
    else unmatched.push(sub.name);
  }
  if (unmatched.length) toast(`Couldn't match ${unmatched.length === 1 ? unmatched[0] : `${unmatched.length} subtitle files`} to a video. Add subtitles from the video's page instead.`);
  else if (others && !added.length) toast("Those don't look like video files.");
  emit();
}

/** Collects files from a drop, including files inside dropped folders. */
async function filesFromDrop(dataTransfer) {
  const roots = [...(dataTransfer.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!roots.length) return [...dataTransfer.files];
  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej)).catch(() => null);
      if (file) {
        file.relativePath = prefix + file.name;
        out.push(file);
      }
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res) => reader.readEntries(res, () => res([])));
        if (!batch.length) break;
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      }
    }
  };
  for (const r of roots) await walk(r, '');
  return out;
}

// ---------------------------------------------------------------- uploading

function validate(e) {
  const f = e.fields;
  if (f.kind === 'movie' && !f.title?.trim()) return 'Enter a title';
  if (f.kind === 'episode' && !f.show?.trim()) return 'Enter the show name';
  return null;
}

export function startAll() {
  let invalid = 0;
  for (const e of entries.filter((x) => x.state === 'pending' || x.state === 'error')) {
    e.error = validate(e);
    if (e.error) invalid++;
    else e.state = 'queued';
  }
  emit();
  pump();
  return invalid;
}

function pump() {
  if (entries.some((e) => e.state === 'uploading' || e.state === 'finishing')) return;
  const next = entries.find((e) => e.state === 'queued');
  if (next) run(next);
}

function trackSpeed(e) {
  const now = performance.now();
  e.samples.push([now, e.loaded]);
  while (e.samples.length > 2 && now - e.samples[0][0] > 6000) e.samples.shift();
  const [t0, b0] = e.samples[0];
  if (now - t0 > 700) e.speed = ((e.loaded - b0) / (now - t0)) * 1000;
}

function sendChunk(e, start) {
  const end = Math.min(start + CHUNK, e.file.size);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    e.xhr = xhr;
    xhr.open('PUT', `/api/uploads/${e.uploadId}?offset=${start}`);
    xhr.timeout = 5 * 60 * 1000;
    xhr.upload.onprogress = (ev) => {
      e.loaded = start + ev.loaded;
      trackSpeed(e);
      emit();
    };
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status === 200 || (xhr.status === 409 && typeof data.offset === 'number')) return resolve(data.offset);
      const err = new Error(xhr.status === 401 ? 'You were logged out. Log in again, then retry.' : data.error || `Upload failed (${xhr.status})`);
      err.status = xhr.status;
      reject(err);
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.ontimeout = () => reject(new Error('The connection timed out'));
    xhr.onabort = () => reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
    xhr.send(e.file.slice(start, end));
  });
}

async function run(e) {
  e.state = 'uploading';
  e.error = null;
  e.samples = [];
  emit();
  try {
    const key = `${e.file.name}|${e.file.size}|${e.file.lastModified}`;
    const { uploadId, offset } = await api('/uploads', {
      method: 'POST',
      body: { key, filename: e.file.name, size: e.file.size, ...e.fields },
    });
    e.uploadId = uploadId;
    let pos = offset;
    e.loaded = pos;
    let failures = 0;
    while (pos < e.file.size) {
      if (e.cancelled) throw Object.assign(new Error('Cancelled'), { cancelled: true });
      try {
        const newPos = await sendChunk(e, pos);
        if (newPos === pos) await sleep(1000);
        pos = newPos;
        e.loaded = pos;
        failures = 0;
        e.retrying = false;
      } catch (err) {
        if (err.cancelled || (err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429)) throw err;
        if (++failures > MAX_RETRIES) throw new Error('Lost connection to the server. Press Retry to continue where it stopped.');
        e.retrying = true;
        emit();
        await sleep(Math.min(30_000, 1000 * 2 ** failures));
        const status = await api(`/uploads/${uploadId}`).catch(() => null);
        if (status) pos = status.offset;
      }
    }
    e.state = 'finishing';
    emit();
    const item = await api(`/uploads/${uploadId}/complete`, { method: 'POST' });
    e.item = item;
    for (const sub of e.subs) {
      await api(`/items/${item.id}/subtitles?filename=${encodeURIComponent(sub.name)}`, {
        method: 'POST', raw: sub, headers: { 'Content-Type': 'text/plain' },
      }).catch((err) => toast(`${sub.name}: ${err.message}`));
    }
    // With ffmpeg the server makes a better thumbnail; without it, grab one here.
    if (!item.art && item.status !== 'checking') await uploadLocalThumbnail(item.id, e.file);
    e.state = 'done';
    invalidate();
  } catch (err) {
    if (err.cancelled) {
      entries.splice(entries.indexOf(e), 1);
      if (e.uploadId) api(`/uploads/${e.uploadId}`, { method: 'DELETE' }).catch(() => {});
    } else {
      e.state = 'error';
      e.error = err.message;
    }
  }
  e.xhr = null;
  emit();
  pump();
}

async function uploadLocalThumbnail(id, file) {
  const url = URL.createObjectURL(file);
  const v = h('video', { muted: true, playsinline: true, preload: 'auto', src: url });
  const once = (type) => new Promise((resolve, reject) => {
    v.addEventListener(type, resolve, { once: true });
    v.addEventListener('error', reject, { once: true });
    setTimeout(reject, 8000);
  });
  try {
    await once('loadeddata');
    v.currentTime = Math.min((v.duration || 60) * 0.15, 600);
    await once('seeked');
    const blob = await captureFrame(v);
    if (blob) await api(`/items/${id}/thumb`, { method: 'PUT', raw: blob, headers: { 'Content-Type': 'image/jpeg' } });
  } catch {
    // Not every format can be previewed in the browser; the player will try later.
  } finally {
    v.removeAttribute('src');
    v.load();
    URL.revokeObjectURL(url);
  }
}

function cancel(e) {
  if (e.state === 'pending' || e.state === 'error' || e.state === 'done') {
    entries.splice(entries.indexOf(e), 1);
    if (e.state === 'error' && e.uploadId) api(`/uploads/${e.uploadId}`, { method: 'DELETE' }).catch(() => {});
  } else if (e.state === 'queued') {
    e.state = 'pending';
  } else {
    e.cancelled = true;
    e.xhr?.abort();
  }
  emit();
}

// ---------------------------------------------------------------- view

function seg(entry, onChange) {
  const button = (kind, label) => h(`button${entry.fields.kind === kind ? '.on' : ''}`, {
    type: 'button',
    onClick: () => {
      if (entry.fields.kind === kind) return;
      const p = parseName(entry.file.name, { tv: kind === 'episode' });
      entry.fields = kind === 'episode'
        ? { kind, show: p.show || entry.fields.title || '', season: p.season ?? 1, episode: p.episode, title: p.title }
        : { kind, title: entry.fields.show || p.title, year: p.year };
      onChange();
    },
  }, label);
  return h('div.seg', { role: 'group', 'aria-label': 'Type' }, button('movie', 'Movie'), button('episode', 'TV episode'));
}

function input(entry, key, label, opts = {}) {
  const el = h('input', {
    type: opts.type ?? 'text',
    value: entry.fields[key] ?? '',
    placeholder: opts.placeholder,
    inputmode: opts.type === 'number' ? 'numeric' : undefined,
    list: opts.list,
    autocomplete: 'off',
    onInput: () => (entry.fields[key] = opts.type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value),
  });
  return h(`label.field${opts.cls ? `.${opts.cls}` : ''}`, h('span', label), el);
}

function summary(e) {
  const f = e.fields;
  if (f.kind === 'movie') return `Movie · ${f.title}${f.year ? ` (${f.year})` : ''}`;
  return `${f.show} · S${f.season ?? '?'}${f.episode != null ? ` · E${f.episode}` : ''}${f.title ? ` · ${f.title}` : ''}`;
}

function rowView(e) {
  const editable = e.state === 'pending' || e.state === 'error';
  const row = h(`div.upload-row${e.state === 'done' ? '.done' : ''}${e.error ? '.error' : ''}`);
  const head = h('div.upload-head',
    h('div.file',
      h('div.file-name', { title: e.file.name }, editable ? e.file.name : summary(e)),
      h('div.file-sub', editable ? bytes(e.file.size) : `${e.file.name} · ${bytes(e.file.size)}`)),
    editable && seg(e, emit),
    e.state === 'done' && e.item && h('a.btn.small', { href: e.item.kind === 'episode' ? `#/show/${e.item.showId}` : `#/movie/${e.item.id}` }, 'Open'),
    h('button.icon-btn', { type: 'button', 'aria-label': e.state === 'uploading' ? 'Cancel upload' : 'Remove', title: e.state === 'uploading' ? 'Cancel upload' : 'Remove', onClick: () => cancel(e) }, icon('close')),
  );
  row.append(head);
  if (editable) {
    const f = e.fields;
    row.append(f.kind === 'movie'
      ? h('div.upload-fields', input(e, 'title', 'Title'), input(e, 'year', 'Year', { type: 'number', placeholder: 'Optional' }))
      : h('div.upload-fields.tv',
        input(e, 'show', 'Show', { list: 'known-shows', cls: 'show' }),
        input(e, 'season', 'Season', { type: 'number' }),
        input(e, 'episode', 'Episode', { type: 'number' }),
        input(e, 'title', 'Episode title', { placeholder: 'Optional', cls: 'wide' })));
  }
  if (e.subs.length) row.append(h('div.subs-note', icon('cc'), `With subtitles: ${e.subs.map((s) => s.name).join(', ')}`));
  if (!editable) {
    const meter = h('i');
    const left = h('span');
    const right = h('span');
    row.append(h('div.upload-progress', h('div.meter', meter), h('div.upload-stats', left, right)));
    row.update = () => {
      const pct = e.state === 'done' ? 1 : e.loaded / e.file.size;
      meter.style.width = `${(pct * 100).toFixed(1)}%`;
      if (e.state === 'queued') left.textContent = 'Waiting…';
      else if (e.state === 'finishing') left.textContent = 'Adding to your library…';
      else if (e.state === 'done') left.textContent = 'Uploaded';
      else left.textContent = `${Math.floor(pct * 100)}% · ${bytes(e.loaded)} of ${bytes(e.file.size)}`;
      let stats = '';
      if (e.state === 'uploading' && e.retrying) stats = 'Connection lost, retrying…';
      else if (e.state === 'uploading' && e.speed) {
        const eta = duration((e.file.size - e.loaded) / e.speed);
        stats = `${bytes(e.speed)}/s · ${eta ? `${eta} left` : 'almost done'}`;
      }
      right.textContent = stats;
    };
    row.update();
  }
  if (e.error) row.append(h('div.err', e.error));
  row.dataset.state = `${e.state}|${e.error ?? ''}|${e.fields.kind}`;
  return row;
}

export async function uploadView() {
  const lib = await getLibrary().catch(() => cachedLibrary());
  const list = h('div.upload-list');
  const bar = h('div.upload-bar');
  const rows = new Map();
  const knownShows = h('datalist', { id: 'known-shows' });

  const dropzone = h('div.dropzone', {
    role: 'button',
    tabindex: 0,
    onClick: async (ev) => {
      if (ev.target.closest('.folder-btn')) return;
      addFiles(await pickFiles({ multiple: true, accept: 'video/*,.mkv,.avi,.m4v,.mov,.wmv,.ts,.srt,.vtt' }));
    },
    onKeydown: (ev) => (ev.key === 'Enter' || ev.key === ' ') && (ev.preventDefault(), dropzone.click()),
    onDragover: (ev) => (ev.preventDefault(), dropzone.classList.add('over')),
    onDragleave: () => dropzone.classList.remove('over'),
    onDrop: async (ev) => {
      ev.preventDefault();
      dropzone.classList.remove('over');
      addFiles(await filesFromDrop(ev.dataTransfer));
    },
  },
  h('div.big-icon', icon('upload')),
  h('strong', 'Drop movies or episodes here'),
  h('p', 'or tap to choose files · subtitles (.srt) are picked up too'),
  'webkitdirectory' in document.createElement('input') && matchMedia('(pointer: fine)').matches &&
    h('button.btn.small.folder-btn', { type: 'button', onClick: async () => addFiles(await pickFiles({ directory: true })) }, icon('folder'), 'Choose a whole folder'));

  function sync() {
    const names = new Set([...(cachedLibrary()?.shows ?? lib?.shows ?? []).map((s) => s.title), ...entries.map((e) => e.fields.show).filter(Boolean)]);
    knownShows.replaceChildren(...[...names].map((n) => h('option', { value: n })));
    const seen = new Set();
    for (const e of entries) {
      seen.add(e.id);
      let row = rows.get(e.id);
      const state = `${e.state}|${e.error ?? ''}|${e.fields.kind}`;
      if (!row || row.dataset.state !== state) {
        const fresh = rowView(e);
        if (row) row.replaceWith(fresh);
        row = fresh;
        rows.set(e.id, row);
      } else row.update?.();
      list.append(row); // keeps DOM order in sync (moves, doesn't recreate)
    }
    for (const [id, row] of rows) if (!seen.has(id)) (row.remove(), rows.delete(id));

    const pending = entries.filter((e) => e.state === 'pending' || e.state === 'error');
    const active = uploads.active();
    const done = entries.filter((e) => e.state === 'done');
    bar.replaceChildren(
      h('span.muted', active.length
        ? `Uploading ${active.length} file${active.length === 1 ? '' : 's'} · ${Math.floor(uploads.progress() * 100)}% · keep this tab open`
        : pending.length ? `${pending.length} file${pending.length === 1 ? '' : 's'} ready. Check the names, then upload.`
          : done.length ? 'All done. They’re in your library.' : ''),
      done.length > 0 && !active.length && h('button.btn.ghost.small', { type: 'button', onClick: () => {
        for (const e of done) entries.splice(entries.indexOf(e), 1);
        emit();
      } }, 'Clear finished'),
      pending.length > 0 && h('button.btn.primary', { type: 'button', onClick: () => {
        const invalid = startAll();
        if (invalid) toast(`Fill in the missing name${invalid === 1 ? '' : 's'} first.`);
      } }, icon('upload'), `Upload ${pending.length === 1 ? '' : `${pending.length} `}${pending.length === 1 ? 'file' : 'files'}`),
    );
    bar.hidden = !entries.length;
  }

  const unsubscribe = uploads.subscribe(() => (list.isConnected ? sync() : unsubscribe()));
  sync();

  const info = await api('/info').catch(() => null);
  return h('div',
    h('div.page-head', h('h1', 'Upload')),
    dropzone,
    knownShows,
    bar,
    list,
    h('p.tip',
      'Big library? On the computer running the server you can skip uploading: copy files into ',
      h('code', info ? `${info.mediaDir}/movies` : 'media/movies'), ' or ', h('code', info ? `${info.mediaDir}/tv/Show Name` : 'media/tv/Show Name'),
      ' and they show up within a few minutes (or press Rescan in Settings).'),
  );
}
