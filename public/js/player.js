import { api, cachedLibrary, invalidate, libraryWith } from './api.js';
import { isWatched, nextEpisode } from './model.js';
import { artwork, captureFrame, clock, duration, episodeCode, h, icon, pickFiles, sheet, toast } from './ui.js';

// One <video> element for the whole session. iPhones only let a page start playback
// from a tap, and that permission sticks to the element, so we keep reusing it
// (which is also what lets the next episode start by itself).

const SAVE_EVERY_MS = 10_000;
const UP_NEXT_SECONDS = 10;
const SUBTITLE_PREF = 'movies.subtitles';

const root = document.getElementById('player');
let video, titleEl, subEl, nextBtn, ccBtn, overlay;
let current = null;
let idleTimer = null;
let countdown = null;
let openedFromApp = false;

function build() {
  if (video) return;
  video = h('video', { controls: true, playsinline: true, preload: 'auto', 'x-webkit-airplay': 'allow' });
  titleEl = h('strong');
  subEl = h('span');
  nextBtn = h('button.btn', { type: 'button', hidden: true, onClick: () => playNext() }, icon('next'), h('span', 'Next episode'));
  ccBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Subtitles', title: 'Subtitles (c)', onClick: subtitleMenu }, icon('cc'));
  overlay = h('div');
  root.append(
    h('div.player-stage', video),
    h('div.player-bar',
      h('button.icon-btn', { type: 'button', 'aria-label': 'Back', onClick: goBack }, icon('back')),
      h('div.player-title', titleEl, subEl),
      nextBtn,
      ccBtn,
    ),
    overlay,
  );

  video.addEventListener('loadedmetadata', onMetadata);
  video.addEventListener('canplay', applyResume);
  video.addEventListener('playing', () => {
    applyResume();
    wake();
  });
  video.addEventListener('seeked', () => {
    if (current && !current.ready && video.currentTime >= current.resumeAt - 2) current.ready = true;
    save();
  });
  video.addEventListener('timeupdate', onTimeUpdate);
  video.addEventListener('pause', () => {
    save(true);
    wake(true);
  });
  video.addEventListener('ended', onEnded);
  video.addEventListener('error', onError);
  video.textTracks.addEventListener?.('change', rememberSubtitleChoice);

  for (const type of ['pointermove', 'pointerdown', 'touchstart']) root.addEventListener(type, () => wake(), { passive: true });
  window.addEventListener('keydown', onKey, true);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && beacon());
  window.addEventListener('pagehide', beacon);
}

// ---------------------------------------------------------------- public API

/** Start playing from a click/tap handler (so iPhones allow sound). */
export function play(item, { fromStart = false } = {}) {
  build();
  openedFromApp = true;
  root.hidden = false;
  document.body.style.overflow = 'hidden';
  load(item, { fromStart });
  location.hash = `#/watch/${item.id}`;
}

/** Called by the router for #/watch/<id>, e.g. when the page is reloaded. */
export async function show(id) {
  build();
  root.hidden = false;
  document.body.style.overflow = 'hidden';
  if (current?.item.id === id) return;
  const lib = await libraryWith(id).catch(() => null);
  const item = lib?.items.get(id);
  if (!item) {
    titleEl.textContent = 'Video not found';
    subEl.textContent = '';
    return message('This video is no longer in your library.', 'It may have been deleted or renamed.');
  }
  load(item, {});
}

/** Called by the router when navigating away from the player. */
export function hide() {
  if (!video || root.hidden) return;
  save(true);
  video.pause();
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  video.removeAttribute('src');
  video.querySelectorAll('track').forEach((t) => t.remove());
  video.load();
  clearOverlay();
  current = null;
  root.hidden = true;
  document.body.style.overflow = '';
  document.title = 'Movies';
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
  invalidate();
}

// ---------------------------------------------------------------- loading

function load(item, { fromStart }) {
  if (current) save(true);
  clearOverlay();
  const lib = cachedLibrary();
  const showInfo = item.kind === 'episode' ? lib?.showById.get(item.showId) : null;
  const next = showInfo ? nextEpisode(showInfo, item) : null;
  const p = item.progress;
  const resumeAt = !fromStart && p && !p.watched && p.position > 10 ? Math.max(0, p.position - 3) : 0;
  current = { item, show: showInfo, next, resumeAt, ready: resumeAt === 0, lastSaved: resumeAt, lastSaveAt: Date.now(), thumbTried: Boolean(item.art), upNextShown: false };

  titleEl.textContent = item.kind === 'episode' ? item.show : item.title;
  subEl.textContent = item.kind === 'episode'
    ? [episodeCode(item), item.title].filter(Boolean).join(' · ')
    : [item.year, duration(item.duration)].filter(Boolean).join(' · ');
  document.title = `${item.kind === 'episode' ? `${item.show} ${episodeCode(item)}` : item.title} · Movies`;
  nextBtn.hidden = !next;
  ccBtn.hidden = false;

  video.querySelectorAll('track').forEach((t) => t.remove());
  for (const s of item.subtitles) {
    video.append(h('track', { kind: 'subtitles', label: s.label, srclang: s.lang || 'und', src: subtitleUrl(item, s) }));
  }
  // "#t=" makes Safari start at the right spot; applyResume() covers the rest.
  video.src = `${streamUrl(item)}${resumeAt ? `#t=${Math.floor(resumeAt)}` : ''}`;
  video.play().catch(() => {}); // blocked without a tap on some phones: the native play button takes over
  if (resumeAt) resumeToast(resumeAt);
  setMediaSession(item);
  wake(true);
}

// Signed URLs so AirPlay / Chromecast receivers (which don't have our cookie) can play too.
const streamUrl = (item) => `/api/stream/${item.id}?t=${item.token}`;
const subtitleUrl = (item, s) => `/api/subtitles/${item.id}/${s.id}.vtt?t=${item.token}`;

function onMetadata() {
  applyResume();
  applySubtitlePreference();
}

function applyResume() {
  if (!current || current.ready || !video.duration) return;
  if (Math.abs(video.currentTime - current.resumeAt) > 2) video.currentTime = current.resumeAt;
  else current.ready = true;
}

function resumeToast(at) {
  const el = h('div.player-toast', `Resuming from ${clock(at)}`,
    h('button.btn', { type: 'button', onClick: () => {
      el.remove();
      current.ready = true;
      video.currentTime = 0;
      video.play().catch(() => {});
    } }, icon('restart'), 'Start over'));
  overlay.append(el);
  setTimeout(() => el.remove(), 8000);
}

// ---------------------------------------------------------------- saving progress

function progressBody() {
  if (!current?.ready || !Number.isFinite(video.duration) || !video.duration) return null;
  const position = video.ended ? video.duration : video.currentTime;
  return position >= 1 ? { position, duration: video.duration } : null;
}

function save(force = false) {
  const body = progressBody();
  if (!body || (!force && Math.abs(body.position - current.lastSaved) < 3)) return;
  current.lastSaved = body.position;
  current.lastSaveAt = Date.now();
  const item = current.item;
  item.progress = { ...body, watched: isWatched(body.position, body.duration), updatedAt: Date.now() };
  api(`/progress/${item.id}`, { method: 'POST', body }).catch(() => {});
}

/** Last-chance save when the phone locks or the tab closes. */
function beacon() {
  const body = progressBody();
  if (!body || !navigator.sendBeacon) return save(true);
  current.lastSaved = body.position;
  current.item.progress = { ...body, watched: isWatched(body.position, body.duration), updatedAt: Date.now() };
  navigator.sendBeacon(`/api/progress/${current.item.id}`, new Blob([JSON.stringify(body)], { type: 'text/plain' }));
}

function onTimeUpdate() {
  if (!current) return;
  if (Date.now() - current.lastSaveAt > SAVE_EVERY_MS) save(true);
  if (current.next && !current.upNextShown && video.duration && isWatched(video.currentTime, video.duration)) {
    current.upNextShown = true;
    upNextCard(false);
  }
  maybeCaptureThumbnail();
}

// Without ffmpeg on the server, the first viewer's browser supplies the thumbnail.
async function maybeCaptureThumbnail() {
  if (current.thumbTried || cachedLibrary()?.ffmpeg || video.currentTime < 5 || video.paused) return;
  current.thumbTried = true;
  const blob = await captureFrame(video);
  if (blob) api(`/items/${current.item.id}/thumb`, { method: 'PUT', raw: blob, headers: { 'Content-Type': 'image/jpeg' } }).catch(() => {});
}

// ---------------------------------------------------------------- end of video

function onEnded() {
  save(true);
  wake(true);
  if (current?.next) upNextCard(true);
}

function upNextCard(autoAdvance) {
  const next = current.next;
  overlay.querySelector('.upnext')?.remove();
  clearInterval(countdown);
  const label = h('small', 'Next episode');
  const card = h('div.upnext',
    artwork(next.art, `${next.show} ${episodeCode(next)}`),
    h('div.info', label,
      h('strong', [episodeCode(next), next.title].filter(Boolean).join(' · ')),
      h('div.buttons',
        h('button.btn.primary', { type: 'button', onClick: () => playNext() }, icon('play'), 'Play'),
        h('button.btn', { type: 'button', onClick: () => (clearInterval(countdown), card.remove()) }, 'Dismiss'))));
  overlay.append(card);
  if (!autoAdvance) return;
  let left = UP_NEXT_SECONDS;
  label.textContent = `Next episode in ${left}`;
  countdown = setInterval(() => {
    left -= 1;
    label.textContent = `Next episode in ${left}`;
    if (left <= 0) playNext();
  }, 1000);
}

function playNext() {
  const next = current?.next;
  if (!next) return;
  save(true);
  load(next, { fromStart: Boolean(next.progress?.watched) });
  location.replace(`#/watch/${next.id}`);
}

function clearOverlay() {
  clearInterval(countdown);
  overlay?.replaceChildren();
}

function message(title, text, actions = []) {
  clearOverlay();
  overlay.append(h('div.player-message', h('div', h('h2', title), h('p', text),
    h('div.actions', { style: { justifyContent: 'center' } }, actions, h('button.btn', { type: 'button', onClick: goBack }, icon('back'), 'Back')))));
}

function onError() {
  if (!current || !video.getAttribute('src')) return;
  const item = current.item;
  const code = video.error?.code;
  if (code === 2) {
    const at = video.currentTime;
    return message('Lost connection to the server', 'Check that the server is still running and your phone is on the same network.', [
      h('button.btn.primary', { type: 'button', onClick: () => {
        clearOverlay();
        current.resumeAt = at;
        current.ready = false;
        video.src = `${streamUrl(item)}#t=${Math.floor(at)}`;
        video.play().catch(() => {});
      } }, icon('refresh'), 'Try again'),
    ]);
  }
  const busy = item.status === 'converting' || item.status === 'queued' || item.status === 'checking';
  message("This video can't play here",
    busy ? "It's being converted into a format phones can play. Try again in a few minutes."
      : item.statusText || "Your browser doesn't support this file's format. Installing ffmpeg on the server lets it convert files automatically.");
}

// ---------------------------------------------------------------- subtitles

function applySubtitlePreference() {
  let pref = null;
  try {
    pref = localStorage.getItem(SUBTITLE_PREF);
  } catch {}
  if (!pref || pref === 'off') return;
  const tracks = [...video.textTracks];
  const match = tracks.find((t) => t.language === pref) ?? tracks.find((t) => t.label === pref);
  if (match) match.mode = 'showing';
}

function rememberSubtitleChoice() {
  if (!current) return;
  const showing = [...video.textTracks].find((t) => t.mode === 'showing');
  try {
    localStorage.setItem(SUBTITLE_PREF, showing ? (showing.language && showing.language !== 'und' ? showing.language : showing.label) : 'off');
  } catch {}
}

function subtitleMenu() {
  if (!current) return;
  const tracks = [...video.textTracks];
  const showing = tracks.find((t) => t.mode === 'showing');
  sheet('Subtitles', [
    { label: 'Off', icon: showing ? 'close' : 'check', on: !showing, onClick: () => selectTrack(null) },
    ...tracks.map((t) => ({ label: t.label || t.language, icon: t === showing ? 'check' : 'cc', on: t === showing, onClick: () => selectTrack(t) })),
    { label: 'Add a subtitle file (.srt, .vtt)…', icon: 'plus', onClick: addSubtitleFile },
  ]);
}

function selectTrack(track) {
  for (const t of video.textTracks) t.mode = t === track ? 'showing' : 'disabled';
  rememberSubtitleChoice();
}

async function addSubtitleFile() {
  const [file] = await pickFiles({ accept: '.srt,.vtt' });
  if (!file || !current) return;
  const item = current.item;
  try {
    const updated = await api(`/items/${item.id}/subtitles?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST', raw: file, headers: { 'Content-Type': 'text/plain' },
    });
    const added = updated.subtitles.find((s) => !item.subtitles.some((o) => o.id === s.id));
    item.subtitles = updated.subtitles;
    if (added) {
      const el = h('track', { kind: 'subtitles', label: added.label, srclang: added.lang || 'und', src: subtitleUrl(item, added) });
      video.append(el);
      el.track.mode = 'showing';
      selectTrack(el.track);
    }
    toast('Subtitles added');
    invalidate();
  } catch (err) {
    toast(err.message);
  }
}

// ---------------------------------------------------------------- controls

function goBack() {
  if (openedFromApp && history.length > 1) return history.back();
  const item = current?.item;
  location.replace(item ? (item.kind === 'episode' ? `#/show/${item.showId}` : `#/movie/${item.id}`) : '#/');
}

/** Shows the top bar, then fades it out after a few seconds of playback. */
function wake(stayVisible = false) {
  root.classList.remove('idle');
  clearTimeout(idleTimer);
  if (!stayVisible && !video.paused) idleTimer = setTimeout(() => !video.paused && root.classList.add('idle'), 3000);
}

function toggleFullscreen() {
  if (document.fullscreenElement) return document.exitFullscreen();
  if (root.requestFullscreen) return root.requestFullscreen().catch(() => {});
  video.webkitEnterFullscreen?.();
}

function onKey(e) {
  if (root.hidden || !current || e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.('input, textarea, select, .modal')) return;
  const actions = {
    ' ': () => (video.paused ? video.play() : video.pause()),
    k: () => (video.paused ? video.play() : video.pause()),
    ArrowLeft: () => (video.currentTime = Math.max(0, video.currentTime - 10)),
    j: () => (video.currentTime = Math.max(0, video.currentTime - 10)),
    ArrowRight: () => (video.currentTime = Math.min(video.duration || 0, video.currentTime + 10)),
    l: () => (video.currentTime = Math.min(video.duration || 0, video.currentTime + 10)),
    f: toggleFullscreen,
    m: () => (video.muted = !video.muted),
    c: subtitleMenu,
    n: () => current.next && playNext(),
    Escape: () => !document.fullscreenElement && goBack(),
  };
  const action = actions[e.key.length === 1 ? e.key.toLowerCase() : e.key];
  if (!action) return;
  e.preventDefault();
  e.stopPropagation();
  action();
  wake();
}

function setMediaSession(item) {
  if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: item.kind === 'episode' ? [episodeCode(item), item.title].filter(Boolean).join(' · ') : item.title,
    artist: item.kind === 'episode' ? item.show : item.year ? String(item.year) : '',
    artwork: item.art ? [{ src: item.art, sizes: '640x360', type: 'image/jpeg' }] : [],
  });
  const handlers = {
    seekbackward: () => (video.currentTime = Math.max(0, video.currentTime - 10)),
    seekforward: () => (video.currentTime += 10),
    nexttrack: current?.next ? playNext : null,
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try {
      navigator.mediaSession.setActionHandler(action, fn);
    } catch {}
  }
}
