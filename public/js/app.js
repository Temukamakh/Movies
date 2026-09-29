import { api, cachedLibrary, getLibrary, invalidate, libraryWith, setUnauthorizedHandler } from './api.js';
import { byTitle, continueWatching, fraction, inProgress, matches, recentlyAdded, remaining, upNext, watched } from './model.js';
import * as player from './player.js';
import { settingsView } from './settings.js';
import {
  artwork, brandMark, bytes, clock, confirm, duration, episodeCode, formDialog, h, icon, imageToJpeg,
  modal, pickFiles, progressBar, sheet, toast, closeModal,
} from './ui.js';
import { uploads, uploadView } from './upload.js';

const app = document.getElementById('app');
let main;
let tabs = [];
let renderToken = 0;

// ---------------------------------------------------------------- boot & auth

async function boot() {
  setUnauthorizedHandler(() => authView());
  let session;
  try {
    session = await api('/session');
  } catch (err) {
    app.replaceChildren(h('div.auth', h('div.auth-card', h('div.brand', brandMark(), 'Movies'), h('h1', "Can't reach the server"), h('p', err.message),
      h('button.btn.primary.block', { type: 'button', onClick: () => location.reload() }, 'Try again'))));
    return;
  }
  if (!session.authenticated) return authView(session);
  startApp();
}

async function authView(session) {
  session ??= await api('/session').catch(() => ({ configured: true }));
  player.hide();
  closeModal();
  main = null;
  const setup = !session.configured;
  const error = h('div.error', { role: 'alert' });
  const password = h('input', { type: 'password', autocomplete: setup ? 'new-password' : 'current-password', placeholder: 'Password', required: true, 'aria-label': 'Password' });
  const again = setup && h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Password again', required: true, 'aria-label': 'Password again' });
  const button = h('button.btn.primary.block', { type: 'submit' }, setup ? 'Create password' : 'Log in');
  const form = h('form', {
    onSubmit: async (e) => {
      e.preventDefault();
      error.textContent = '';
      if (setup && password.value !== again.value) return (error.textContent = "The passwords don't match.");
      button.disabled = true;
      try {
        await api(setup ? '/setup' : '/login', { method: 'POST', body: { password: password.value } });
        startApp();
      } catch (err) {
        error.textContent = err.message;
        button.disabled = false;
        password.select();
      }
    },
  }, password, again, button, error);

  let body;
  if (setup && !session.canSetup) {
    body = [h('h1', 'Almost there'), h('p', 'Open this site on the computer that runs the server (or any device on your home Wi-Fi) to create a password first.')];
  } else if (setup) {
    body = [h('h1', 'Welcome'), h('p', "Create a password for your library. You'll use it to log in on your phone too."), form];
  } else {
    body = [h('h1', 'Welcome back'), h('p', 'Enter your password to watch.'), form];
  }
  app.replaceChildren(h('div.auth', h('div.auth-card', h('div.brand', brandMark(), 'Movies'), body)));
  password.focus();
}

// ---------------------------------------------------------------- shell & router

const NAV = [
  { route: '', href: '#/', icon: 'home', label: 'Home' },
  { route: 'movies', href: '#/movies', icon: 'film', label: 'Movies', also: ['movie'] },
  { route: 'tv', href: '#/tv', icon: 'tv', label: 'TV Shows', short: 'TV', also: ['show'] },
  { route: 'upload', href: '#/upload', icon: 'upload', label: 'Upload' },
  { route: 'settings', href: '#/settings', icon: 'settings', label: 'Settings' },
];

function startApp() {
  const link = (n, short) => {
    const a = h('a.tab', { href: n.href }, icon(n.icon), h('span', short ? (n.short ?? n.label) : n.label));
    a.nav = n;
    return a;
  };
  const pill = h('a.upload-pill', { href: '#/upload', hidden: true });
  const updatePill = () => {
    const active = uploads.active().length;
    pill.hidden = !active;
    if (active) pill.replaceChildren(icon('upload'), `${active} · ${Math.floor(uploads.progress() * 100)}%`);
  };
  uploads.subscribe(updatePill);
  const top = NAV.map((n) => link(n));
  const bottom = NAV.map((n) => link(n, true));
  tabs = [...top, ...bottom];
  main = h('main.page', { id: 'main' });
  app.replaceChildren(
    h('header.topbar', h('a.brand', { href: '#/' }, brandMark(), 'Movies'), h('nav.tabs', { 'aria-label': 'Main' }, top), h('div.topbar-end', pill)),
    main,
    h('nav.tabbar', { 'aria-label': 'Main' }, bottom),
  );
  render();
}

const VIEWS = {
  '': homeView,
  movies: moviesView,
  tv: showsView,
  movie: movieView,
  show: showView,
  upload: uploadView,
  settings: settingsView,
};

function parseHash() {
  const [, route = '', arg = ''] = /^#\/?([a-z]*)\/?([^?]*)/.exec(location.hash) ?? [];
  return { route, arg: decodeURIComponent(arg) };
}

async function render({ keepScroll = false } = {}) {
  if (!main) return;
  const { route, arg } = parseHash();
  if (route === 'watch') return player.show(arg);
  player.hide();
  closeModal();
  const token = ++renderToken;
  for (const t of tabs) t.classList.toggle('active', t.nav.route === route || Boolean(t.nav.also?.includes(route)));
  const view = VIEWS[route] ?? (() => messageView('Page not found', "That link doesn't go anywhere.", 'Go home', '#/'));
  const scroll = keepScroll ? window.scrollY : history.state?.scroll ?? 0;
  const spinner = setTimeout(() => token === renderToken && main.replaceChildren(h('div.loading', h('div.spinner'))), 150);
  let node;
  try {
    node = await view(arg);
  } catch (err) {
    if (err.status === 401) return;
    node = messageView('Something went wrong', err.message, 'Try again', null);
  }
  clearTimeout(spinner);
  if (token !== renderToken) return;
  main.replaceChildren(node);
  document.title = route && VIEWS[route] ? `${node.dataset.title ?? NAV.find((n) => n.route === route)?.label ?? 'Movies'} · Movies` : 'Movies';
  window.scrollTo(0, scroll);
}

/** Re-renders the current page after a change, keeping the scroll position. */
function refresh() {
  invalidate();
  return render({ keepScroll: true });
}

// Remember the scroll position in the history entry so Back returns to the same spot.
let scrollSaveTimer;
window.addEventListener('scroll', () => {
  clearTimeout(scrollSaveTimer);
  scrollSaveTimer = setTimeout(() => {
    if (parseHash().route !== 'watch') history.replaceState({ ...history.state, scroll: window.scrollY }, '');
  }, 250);
}, { passive: true });
window.addEventListener('hashchange', () => render());

function messageView(title, text, actionLabel, href) {
  return h('div.empty', h('div.big-icon', icon('alert')), h('h2', title), h('p', text),
    actionLabel && h('a.btn', { href: href ?? location.hash, onClick: href ? null : (e) => (e.preventDefault(), refresh()) }, actionLabel));
}

// ---------------------------------------------------------------- cards

function overlays(item) {
  const out = [h('div.play-hover', h('span', icon('play')))];
  if (watched(item)) out.push(h('div.badge.watched', { title: 'Watched' }, icon('check')));
  else if (inProgress(item)) out.push(progressBar(fraction(item)));
  if (item.status === 'converting' || item.status === 'queued') out.push(h('div.badge', 'Converting…'));
  else if (item.status === 'unsupported' || item.status === 'failed') out.push(h('div.badge.warn', icon('alert'), 'May not play'));
  return out;
}

function movieCard(m) {
  return h('a.card', { href: `#/movie/${m.id}` },
    artwork(m.art, m.title, overlays(m)),
    h('div.card-title', m.title),
    h('div.card-meta', [m.year, duration(m.duration)].filter(Boolean).join(' · ') || ' '));
}

function showMeta(s) {
  const seasons = new Set(s.episodes.map((e) => e.season)).size;
  const count = `${s.episodes.length} episode${s.episodes.length === 1 ? '' : 's'}`;
  return seasons > 1 ? `${seasons} seasons · ${count}` : count;
}

function showCard(s) {
  const all = s.episodes.every(watched);
  return h('a.card', { href: `#/show/${s.id}` },
    artwork(s.art, s.title, [h('div.play-hover', h('span', icon('play'))), all && h('div.badge.watched', { title: 'Watched' }, icon('check'))]),
    h('div.card-title', s.title),
    h('div.card-meta', showMeta(s)));
}

function continueCard({ item, show, upNext: isNext }) {
  const title = show ? show.title : item.title;
  const left = remaining(item);
  const meta = show
    ? [isNext ? 'Up next' : null, episodeCode(item), !isNext && left ? `${duration(left)} left` : null].filter(Boolean).join(' · ')
    : left ? `${duration(left)} left` : 'Continue';
  return h('a.card', {
    href: `#/watch/${item.id}`,
    onClick: (e) => {
      e.preventDefault();
      player.play(item);
    },
  },
  artwork(item.art ?? show?.art, title, [h('div.play-hover', h('span', icon('play'))), inProgress(item) && progressBar(fraction(item))]),
  h('div.card-title', title),
  h('div.card-meta', meta));
}

function row(title, cards, link) {
  if (!cards.length) return null;
  return h('section.section',
    h('div.section-head', h('h2', title), link && h('a', { href: link.href }, link.label)),
    h('div.scroller', cards));
}

function searchbar(placeholder, onInput, value = '') {
  const input = h('input', { type: 'search', placeholder, value, 'aria-label': placeholder, enterkeyhint: 'search', onInput: () => onInput(input.value) });
  return h('div.searchbar', icon('search'), input);
}

function emptyLibrary() {
  return h('div.empty',
    h('div.big-icon', icon('film')),
    h('h2', 'Your library is empty'),
    h('p', 'Upload movies and TV episodes from this computer, then watch them on your phone. Your spot is saved, so you can switch devices mid-movie.'),
    h('a.btn.primary', { href: '#/upload' }, icon('upload'), 'Upload videos'));
}

// ---------------------------------------------------------------- home / lists

async function homeView() {
  const lib = await getLibrary();
  if (!lib.items.size) return emptyLibrary();
  const results = h('div');
  const byAdded = (a, b) => b.addedAt - a.addedAt;
  const rows = h('div',
    row('Continue watching', continueWatching(lib).map(continueCard)),
    row('Recently added', recentlyAdded(lib).map((r) => (r.movie ? movieCard(r.movie) : showCard(r.show)))),
    row('Movies', [...lib.movies].sort(byTitle).slice(0, 24).map(movieCard), lib.movies.length > 3 && { href: '#/movies', label: 'See all' }),
    row('TV shows', [...lib.shows].sort(byAdded).slice(0, 24).map(showCard), lib.shows.length > 3 && { href: '#/tv', label: 'See all' }));
  const search = (q) => {
    rows.hidden = Boolean(q.trim());
    if (!q.trim()) return results.replaceChildren();
    const movies = lib.movies.filter((m) => matches(q, m.title, m.year)).sort(byTitle);
    const shows = lib.shows.filter((s) => matches(q, s.title, ...s.episodes.map((e) => e.title))).sort(byTitle);
    results.replaceChildren(movies.length || shows.length
      ? h('div.grid', { style: { marginTop: '8px' } }, shows.map(showCard), movies.map(movieCard))
      : h('p.muted', `Nothing matches “${q.trim()}”.`));
  };
  return h('div', h('div.toolbar', searchbar('Search movies and shows', search)), results, rows);
}

function readPref(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function listPage({ title, all, card, empty, sorts, prefKey }) {
  let sort = readPref(prefKey) ?? sorts[0][0];
  let query = '';
  const grid = h('div.grid');
  const draw = () => {
    const sorter = sorts.find((s) => s[0] === sort)?.[2] ?? sorts[0][2];
    const list = all.filter((x) => matches(query, x.title, x.year)).sort(sorter);
    grid.replaceChildren(...list.map(card));
    if (!list.length) grid.replaceChildren(h('p.muted', { style: { gridColumn: '1 / -1' } }, `Nothing matches “${query.trim()}”.`));
  };
  const select = h('select', {
    'aria-label': 'Sort',
    onChange: () => {
      sort = select.value;
      try {
        localStorage.setItem(prefKey, sort);
      } catch {}
      draw();
    },
  }, sorts.map(([value, label]) => h('option', { value, selected: value === sort }, label)));
  draw();
  if (!all.length) return empty;
  return h('div', { dataset: { title } },
    h('div.page-head', h('h1', title, h('span.count', all.length))),
    h('div.toolbar', searchbar(`Search ${title.toLowerCase()}`, (q) => ((query = q), draw())), select),
    grid);
}

async function moviesView() {
  const lib = await getLibrary();
  return listPage({
    title: 'Movies',
    all: lib.movies,
    card: movieCard,
    prefKey: 'movies.sort.movies',
    sorts: [
      ['added', 'Recently added', (a, b) => b.addedAt - a.addedAt],
      ['title', 'Title', byTitle],
      ['year', 'Release year', (a, b) => (b.year ?? 0) - (a.year ?? 0) || byTitle(a, b)],
      ['unwatched', 'Unwatched first', (a, b) => watched(a) - watched(b) || b.addedAt - a.addedAt],
    ],
    empty: h('div.empty', h('div.big-icon', icon('film')), h('h2', 'No movies yet'), h('p', 'Upload a movie and it will show up here.'),
      h('a.btn.primary', { href: '#/upload' }, icon('upload'), 'Upload movies')),
  });
}

async function showsView() {
  const lib = await getLibrary();
  const lastWatched = (s) => Math.max(0, ...s.episodes.map((e) => e.progress?.updatedAt ?? 0));
  return listPage({
    title: 'TV Shows',
    all: lib.shows,
    card: showCard,
    prefKey: 'movies.sort.shows',
    sorts: [
      ['added', 'Recently added', (a, b) => b.addedAt - a.addedAt],
      ['title', 'Title', byTitle],
      ['watched', 'Recently watched', (a, b) => lastWatched(b) - lastWatched(a) || byTitle(a, b)],
    ],
    empty: h('div.empty', h('div.big-icon', icon('tv')), h('h2', 'No TV shows yet'), h('p', "Upload episodes and they'll be grouped by show and season."),
      h('a.btn.primary', { href: '#/upload' }, icon('upload'), 'Upload episodes')),
  });
}

// ---------------------------------------------------------------- shared actions

async function setWatched(item, value) {
  await api(`/items/${item.id}/watched`, { method: 'POST', body: { watched: value } });
  toast(value ? 'Marked as watched' : 'Marked as unwatched');
  refresh();
}

async function changePicture(key, hasCustom) {
  const [file] = await pickFiles({ accept: 'image/*' });
  if (!file) return;
  try {
    const jpeg = await imageToJpeg(file);
    await api(`/art/${key}`, { method: 'PUT', raw: jpeg, headers: { 'Content-Type': 'image/jpeg' } });
    toast(hasCustom ? 'Picture replaced' : 'Picture updated');
    refresh();
  } catch (err) {
    toast(err.message);
  }
}

async function removePicture(key) {
  await api(`/art/${key}`, { method: 'DELETE' });
  toast('Picture removed');
  refresh();
}

function subtitlesDialog(item) {
  const list = h('div.track-list');
  const draw = (it) => {
    list.replaceChildren(...(it.subtitles.length ? it.subtitles.map((s) => h('div.track', icon('cc'), h('span', s.label),
      s.removable ? h('button.icon-btn', { type: 'button', 'aria-label': `Remove ${s.label}`, onClick: async () => {
        try {
          draw(await api(`/items/${it.id}/subtitles/${s.id}`, { method: 'DELETE' }));
          invalidate();
        } catch (err) {
          toast(err.message);
        }
      } }, icon('trash')) : h('small', 'from file'))) : [h('p.muted', { style: { margin: 0 } }, 'No subtitles yet.')]));
  };
  draw(item);
  modal([
    h('h3', 'Subtitles'),
    h('p', 'Add .srt or .vtt files. Pick them from the CC button while watching.'),
    h('div', { style: { marginTop: '14px' } }, list),
    h('div.modal-actions',
      h('button.btn.ghost', { type: 'button', onClick: () => (closeModal(), refresh()) }, 'Done'),
      h('button.btn.primary', { type: 'button', onClick: async () => {
        const files = await pickFiles({ accept: '.srt,.vtt', multiple: true });
        for (const file of files) {
          try {
            const updated = await api(`/items/${item.id}/subtitles?filename=${encodeURIComponent(file.name)}`, {
              method: 'POST', raw: file, headers: { 'Content-Type': 'text/plain' },
            });
            draw(updated);
            invalidate();
          } catch (err) {
            toast(`${file.name}: ${err.message}`);
          }
        }
      } }, icon('plus'), 'Add file')),
  ], { label: 'Subtitles' });
}

function statusNotice(item) {
  const convertNow = () => h('button.btn.small', { type: 'button', onClick: async () => {
    try {
      await api(`/items/${item.id}/convert`, { method: 'POST' });
      toast('Converting. This page updates when it’s done.');
      refresh();
    } catch (err) {
      toast(err.message);
    }
  } }, icon('wand'), item.status === 'failed' ? 'Try again' : 'Convert for phones');
  const lib = cachedLibrary();
  switch (item.status) {
    case 'converting':
      return h('div.notice', icon('wand'), h('div', h('strong', `Converting for phones · ${Math.round((item.jobProgress ?? 0) * 100)}%`),
        h('div', 'It will play on phones once this finishes. This page updates by itself.'),
        h('div.meter', h('i', { style: { width: `${(item.jobProgress ?? 0) * 100}%` } }))));
    case 'queued':
      return h('div.notice', icon('wand'), h('div', h('strong', 'Waiting to be converted for phones'), h('div', 'Other videos are being converted first.')));
    case 'checking':
      return h('div.notice', icon('refresh'), h('div', h('strong', 'Checking the file…'), h('div', "Making sure it'll play on phones.")));
    case 'failed':
      return h('div.notice.bad', icon('alert'), h('div', h('strong', "Couldn't convert this file"), h('div', item.statusText), convertNow()));
    case 'needs-convert':
      return h('div.notice', icon('alert'), h('div', h('strong', 'Might not play on phones'), h('div', item.statusText), lib?.ffmpeg && convertNow()));
    case 'limited':
    case 'unsupported':
      return h('div.notice', icon('alert'), h('div', h('strong', 'Might not play everywhere'), h('div', item.statusText)));
    default:
      return null;
  }
}

/** Keeps a status notice current while the server is converting or checking a file. */
function liveStatus(item) {
  let node = statusNotice(item) ?? h('div', { hidden: true });
  const busy = (it) => ['converting', 'queued', 'checking'].includes(it?.status);
  if (!busy(item)) return node;
  const tick = async () => {
    if (!node.isConnected) return;
    const lib = await getLibrary({ force: true }).catch(() => null);
    const fresh = lib?.items.get(item.id);
    if (!node.isConnected || !fresh) return;
    if (!busy(fresh)) return refresh();
    const next = statusNotice(fresh) ?? h('div', { hidden: true });
    node.replaceWith(next);
    node = next;
    setTimeout(tick, 2500);
  };
  setTimeout(tick, 2500);
  return node;
}

function heroArt(url, title) {
  const art = artwork(url, title);
  art.className = 'hero-art';
  return art;
}

// ---------------------------------------------------------------- movie page

async function movieView(id) {
  const lib = await libraryWith(id);
  const m = lib.items.get(id);
  if (!m || m.kind !== 'movie') return messageView('Movie not found', 'It may have been deleted.', 'Go to Movies', '#/movies');
  const resuming = inProgress(m);
  const edit = () => formDialog({
    title: 'Edit movie',
    fields: [
      { name: 'title', label: 'Title', value: m.title, required: true },
      { name: 'year', label: 'Year', value: m.year ?? '', type: 'number', placeholder: 'Unknown' },
    ],
    onSubmit: async (v) => {
      await api(`/items/${m.id}`, { method: 'PATCH', body: { title: v.title, year: v.year === '' ? null : Number(v.year) } });
      toast('Saved');
      refresh();
    },
  });
  const remove = async () => {
    if (!(await confirm({ title: `Delete “${m.title}”?`, message: `This removes the video file (${bytes(m.size)}) from the server. It can't be undone.`, confirmLabel: 'Delete', danger: true }))) return;
    await api(`/items/${m.id}`, { method: 'DELETE' });
    invalidate();
    toast(`Deleted “${m.title}”`);
    location.hash = '#/movies';
  };
  const more = () => sheet(m.title, [
    { label: 'Edit title and year', icon: 'edit', onClick: edit },
    { label: 'Subtitles', icon: 'cc', onClick: () => subtitlesDialog(m) },
    { label: m.hasCustomArt ? 'Change picture' : 'Set a poster picture', icon: 'image', onClick: () => changePicture(m.id, m.hasCustomArt) },
    m.hasCustomArt && { label: 'Remove picture', icon: 'close', onClick: () => removePicture(m.id) },
    { label: watched(m) ? 'Mark as unwatched' : 'Mark as watched', icon: watched(m) ? 'eyeOff' : 'eye', onClick: () => setWatched(m, !watched(m)) },
    { label: 'Delete movie', icon: 'trash', danger: true, onClick: remove },
  ]);

  return h('div', { dataset: { title: m.title } },
    h('div.hero', heroArt(m.art, m.title),
      h('div.hero-body',
        h('h1', m.title),
        h('div.meta-line', [m.year, duration(m.duration), watched(m) ? 'Watched' : null, m.subtitles.length ? 'Subtitles' : null].filter(Boolean).map((t) => h('span', t))),
        resuming && h('div.progress-line', h('div.meter', h('i', { style: { width: `${fraction(m) * 100}%` } })), `${duration(remaining(m))} left`),
        h('div.actions',
          h('button.btn.primary', { type: 'button', onClick: () => player.play(m) }, icon('play'), resuming ? `Resume from ${clock(m.progress.position)}` : watched(m) ? 'Watch again' : 'Play'),
          resuming && h('button.btn', { type: 'button', onClick: () => player.play(m, { fromStart: true }) }, icon('restart'), 'Start over'),
          h('button.btn', { type: 'button', 'aria-label': 'More options', title: 'More', onClick: more }, icon('more'))),
        liveStatus(m))));
}

// ---------------------------------------------------------------- show page

const selectedSeason = new Map();

function episodeTitle(ep) {
  return ep.title || (ep.episode != null ? `Episode ${ep.episode}` : ep.fileName);
}

function episodeMeta(ep) {
  if (inProgress(ep)) return `${duration(remaining(ep))} left`;
  if (watched(ep)) return ['Watched', duration(ep.duration)].filter(Boolean).join(' · ');
  return duration(ep.duration) || ' ';
}

function episodeMenu(ep, show) {
  const edit = () => formDialog({
    title: 'Edit episode',
    fields: [
      { name: 'show', label: 'Show', value: ep.show, list: 'show-names' },
      { name: 'season', label: 'Season', value: ep.season, type: 'number', half: true },
      { name: 'episode', label: 'Episode', value: ep.episode ?? '', type: 'number', half: true },
      { name: 'title', label: 'Episode title', value: ep.title, placeholder: 'Optional' },
    ],
    extra: h('datalist', { id: 'show-names' }, (cachedLibrary()?.shows ?? []).map((s) => h('option', { value: s.title }))),
    onSubmit: async (v) => {
      const updated = await api(`/items/${ep.id}`, {
        method: 'PATCH',
        body: { show: v.show, season: Number(v.season), episode: v.episode === '' ? null : Number(v.episode), title: v.title },
      });
      toast('Saved');
      if (updated.showId !== show.id) {
        invalidate();
        location.hash = `#/show/${updated.showId}`;
      } else refresh();
    },
  });
  const remove = async () => {
    if (!(await confirm({ title: `Delete ${episodeCode(ep)}?`, message: `This removes the video file (${bytes(ep.size)}) from the server.`, confirmLabel: 'Delete', danger: true }))) return;
    await api(`/items/${ep.id}`, { method: 'DELETE' });
    toast('Episode deleted');
    if (show.episodes.length === 1) {
      invalidate();
      location.hash = '#/tv';
    } else refresh();
  };
  sheet(`${episodeCode(ep)} · ${episodeTitle(ep)}`, [
    { label: inProgress(ep) ? `Resume from ${clock(ep.progress.position)}` : 'Play', icon: 'play', onClick: () => player.play(ep) },
    inProgress(ep) && { label: 'Play from the beginning', icon: 'restart', onClick: () => player.play(ep, { fromStart: true }) },
    { label: watched(ep) ? 'Mark as unwatched' : 'Mark as watched', icon: watched(ep) ? 'eyeOff' : 'eye', onClick: () => setWatched(ep, !watched(ep)) },
    { label: 'Subtitles', icon: 'cc', onClick: () => subtitlesDialog(ep) },
    { label: 'Edit details', icon: 'edit', onClick: edit },
    { label: 'Delete episode', icon: 'trash', danger: true, onClick: remove },
  ]);
}

function episodeRow(ep, show) {
  return h('div.episode', {
    role: 'button',
    tabindex: 0,
    'aria-label': `Play ${episodeCode(ep)} ${episodeTitle(ep)}`,
    onClick: () => player.play(ep),
    onKeydown: (e) => e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), player.play(ep)),
  },
  artwork(ep.art, `${show.title} ${episodeCode(ep)}`, overlays(ep)),
  h('div',
    h('div.card-title', ep.episode != null && h('span.ep-num', `${ep.episode}.`), episodeTitle(ep)),
    h('div.card-meta', episodeMeta(ep)),
    ['converting', 'queued', 'checking', 'failed', 'unsupported'].includes(ep.status) && h('div.status', ep.status === 'converting' ? 'Converting for phones…' : ep.status === 'queued' ? 'Waiting to convert' : ep.status === 'checking' ? 'Checking…' : 'May not play')),
  h('button.icon-btn', { type: 'button', 'aria-label': 'Episode options', onClick: (e) => (e.stopPropagation(), episodeMenu(ep, show)) }, icon('more')));
}

async function showView(id) {
  const lib = await libraryWith(id);
  const show = lib.showById.get(id);
  if (!show) return messageView('Show not found', 'It may have been renamed or deleted.', 'Go to TV Shows', '#/tv');
  const next = upNext(show);
  const seasons = [...new Set(show.episodes.map((e) => e.season))].sort((a, b) => a - b);
  if (!seasons.includes(selectedSeason.get(id))) selectedSeason.set(id, next.episode.season);
  const watchedCount = show.episodes.filter(watched).length;

  const list = h('div.episodes');
  const chips = h('div.chips', { role: 'tablist' });
  const drawSeason = () => {
    const season = selectedSeason.get(id);
    chips.replaceChildren(...seasons.map((s) => h(`button.chip${s === season ? '.active' : ''}`, {
      type: 'button', role: 'tab', 'aria-selected': String(s === season),
      onClick: () => (selectedSeason.set(id, s), drawSeason()),
    }, s === 0 ? 'Specials' : `Season ${s}`)));
    list.replaceChildren(...show.episodes.filter((e) => e.season === season).map((e) => episodeRow(e, show)));
  };
  drawSeason();

  const label = { resume: `Resume ${episodeCode(next.episode)}`, next: `Play ${episodeCode(next.episode)}`, start: 'Play', rewatch: 'Watch again' }[next.mode];
  const rename = () => formDialog({
    title: 'Rename show',
    fields: [{ name: 'title', label: 'Show name', value: show.title, required: true }],
    onSubmit: async (v) => {
      const r = await api(`/shows/${id}`, { method: 'PATCH', body: { title: v.title } });
      toast('Renamed');
      invalidate();
      if (r.id !== id) location.hash = `#/show/${r.id}`;
      else refresh();
    },
  });
  const markAll = async (value, season) => {
    await api(`/shows/${id}/watched`, { method: 'POST', body: { watched: value, season } });
    toast(value ? 'Marked as watched' : 'Marked as unwatched');
    refresh();
  };
  const remove = async () => {
    if (!(await confirm({
      title: `Delete “${show.title}”?`,
      message: `This removes all ${show.episodes.length} episode files (${bytes(show.episodes.reduce((n, e) => n + e.size, 0))}) from the server. It can't be undone.`,
      confirmLabel: 'Delete show',
      danger: true,
    }))) return;
    await api(`/shows/${id}`, { method: 'DELETE' });
    invalidate();
    toast(`Deleted “${show.title}”`);
    location.hash = '#/tv';
  };
  const season = () => selectedSeason.get(id);
  const more = () => sheet(show.title, [
    seasons.length > 1 && { label: `Mark season ${season()} as watched`, icon: 'eye', onClick: () => markAll(true, season()) },
    { label: watchedCount === show.episodes.length ? 'Mark all as unwatched' : 'Mark all as watched', icon: watchedCount === show.episodes.length ? 'eyeOff' : 'eye', onClick: () => markAll(watchedCount !== show.episodes.length) },
    { label: 'Rename show', icon: 'edit', onClick: rename },
    { label: show.hasCustomArt ? 'Change picture' : 'Set a poster picture', icon: 'image', onClick: () => changePicture(id, show.hasCustomArt) },
    show.hasCustomArt && { label: 'Remove picture', icon: 'close', onClick: () => removePicture(id) },
    { label: 'Delete show', icon: 'trash', danger: true, onClick: remove },
  ]);

  return h('div', { dataset: { title: show.title } },
    h('div.hero', heroArt(show.art, show.title),
      h('div.hero-body',
        h('h1', show.title),
        h('div.meta-line', h('span', showMeta(show)), watchedCount > 0 && h('span', `${watchedCount} watched`)),
        next.mode === 'resume' && h('div.progress-line', h('div.meter', h('i', { style: { width: `${fraction(next.episode) * 100}%` } })), `${episodeCode(next.episode)} · ${duration(remaining(next.episode))} left`),
        h('div.actions',
          h('button.btn.primary', { type: 'button', onClick: () => player.play(next.episode, { fromStart: next.mode === 'rewatch' }) }, icon('play'), label),
          h('button.btn', { type: 'button', 'aria-label': 'More options', title: 'More', onClick: more }, icon('more'))))),
    h('section.subsection', seasons.length > 1 && chips, list));
}

boot();
