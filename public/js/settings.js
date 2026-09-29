import { api, getLibrary, invalidate } from './api.js';
import { qrSvg } from './qr.js';
import { bytes, formDialog, h, icon, toast } from './ui.js';

const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;

function phonePanel(info) {
  if (info.viaNetwork) {
    return h('section.panel',
      h('h2', 'Watch on your phone'),
      h('p.sub', "You're connected from another device, so you're all set. Open this same address on any phone or tablet on your network."),
      h('div.url-big', location.origin));
  }
  const urls = info.urls;
  if (!urls.length) {
    return h('section.panel',
      h('h2', 'Watch on your phone'),
      h('p.sub', "This computer doesn't seem to be connected to a network. Connect it to Wi-Fi, then come back here."));
  }
  const main = urls[0].url;
  return h('section.panel',
    h('h2', 'Watch on your phone'),
    h('p.sub', 'Connect your phone to the same Wi-Fi as this computer, then scan the code with the camera app (or type the address).'),
    h('div.phone-link',
      h('div.qr', qrSvg(main)),
      h('div.url-list',
        h('div.url-big', main),
        urls.length > 1 && h('div.muted', { style: { fontSize: '13px' } }, 'Other addresses: ', urls.slice(1).map((u) => `${u.url}${u.label === 'Tailscale' ? ' (Tailscale)' : ''}`).join(' · ')),
        h('ol.steps',
          h('li', 'Log in with the same password.'),
          h('li', 'Your progress is shared, so a movie you stop here resumes on your phone.'),
          h('li', 'Keep this computer on and the server running while you watch.')))));
}

function installPanel() {
  if (standalone) return null;
  return h('section.panel',
    h('h2', 'Put it on your home screen'),
    h('p.sub', 'It opens full-screen like an app, without the browser bars.'),
    h('ul.steps',
      h('li', h('strong', 'iPhone / iPad (Safari): '), 'tap the Share button, then "Add to Home Screen".'),
      h('li', h('strong', 'Android (Chrome): '), 'tap ⋮, then "Add to Home screen" or "Install app".')),
    isIOS && h('p.muted', { style: { fontSize: '13px', margin: '10px 0 0' } }, "You'll log in once more inside the home-screen app."));
}

function awayPanel() {
  return h('section.panel',
    h('h2', 'Watching away from home'),
    h('p.sub', { style: { margin: 0 } },
      'The addresses above only work on your home Wi-Fi. To watch anywhere, install the free Tailscale app on this computer and your phone. ',
      'The README has step-by-step instructions, plus a Cloudflare Tunnel option if you want a public link.'));
}

function libraryPanel(info, lib, refresh) {
  const shows = lib.shows.length;
  const episodes = lib.shows.reduce((n, s) => n + s.episodes.length, 0);
  return h('section.panel',
    h('h2', 'Library'),
    h('dl.kv',
      h('dt', 'Movies'), h('dd', String(lib.movies.length)),
      h('dt', 'TV shows'), h('dd', `${shows} (${episodes} episode${episodes === 1 ? '' : 's'})`),
      h('dt', 'Folder'), h('dd', info.mediaDir),
      info.space && [h('dt', 'Free space'), h('dd', `${bytes(info.space.free)} of ${bytes(info.space.total)}`)]),
    h('div.actions',
      h('button.btn.small', { type: 'button', onClick: async (e) => {
        e.currentTarget.disabled = true;
        try {
          const r = await api('/rescan', { method: 'POST' });
          invalidate();
          toast(`Found ${r.items} video${r.items === 1 ? '' : 's'}`);
          refresh();
        } catch (err) {
          toast(err.message);
        }
      } }, icon('refresh'), 'Rescan folder')));
}

function conversionPanel(info, lib) {
  const jobs = lib.jobs.filter((j) => j.type === 'convert' || j.status === 'running');
  let status;
  if (info.ffmpeg) status = h('p.sub', h('span.ok-text', 'ffmpeg is installed. '), info.autoConvert
    ? 'Files phones can\'t play (MKV, AVI, AC3 audio…) are converted automatically, usually in a minute or two per movie.'
    : 'Automatic conversion is off (AUTO_CONVERT=0). Use "Convert" on a movie\'s page.');
  else if (info.ffmpegDisabled) status = h('p.sub', h('span.warn-text', 'ffmpeg is turned off '), '(FFMPEG=0), so files are played exactly as uploaded.');
  else status = h('p.sub', h('span.warn-text', 'ffmpeg isn\'t installed. '), 'MP4 files play fine, but MKV and AVI files may not play on phones (especially iPhones). Install ffmpeg and restart the server to convert them automatically. The README explains how.');
  return h('section.panel',
    h('h2', 'Video conversion'),
    status,
    jobs.map((j) => h('div.job',
      h('div.row', h('span', j.label), h('span.muted', j.status === 'running' ? (j.type === 'convert' ? `${Math.round(j.progress * 100)}%` : 'Working…') : 'Queued')),
      j.type === 'convert' && h('div.meter', h('i', { style: { width: `${j.progress * 100}%` } })))));
}

function accountPanel(info) {
  return h('section.panel',
    h('h2', 'Password'),
    h('p.sub', info.passwordFromEnv
      ? 'The password is set with MOVIES_PASSWORD when the server starts. Change it there.'
      : 'Changing it signs out every other device.'),
    h('div.actions',
      !info.passwordFromEnv && h('button.btn.small', { type: 'button', onClick: changePassword }, icon('edit'), 'Change password'),
      h('button.btn.small.ghost', { type: 'button', onClick: async () => {
        await api('/logout', { method: 'POST' }).catch(() => {});
        location.reload();
      } }, icon('logout'), 'Log out')));
}

function changePassword() {
  formDialog({
    title: 'Change password',
    fields: [
      { name: 'current', label: 'Current password', type: 'password', autocomplete: 'current-password' },
      { name: 'next', label: 'New password', type: 'password', autocomplete: 'new-password' },
      { name: 'again', label: 'New password again', type: 'password', autocomplete: 'new-password' },
    ],
    onSubmit: async ({ current, next, again }) => {
      if (next !== again) throw new Error("The new passwords don't match.");
      await api('/password', { method: 'POST', body: { current, next } });
      toast('Password changed');
    },
  });
}

export async function settingsView() {
  const root = h('div.settings');
  const draw = async () => {
    const [info, lib] = await Promise.all([api('/info'), getLibrary({ force: true })]);
    root.replaceChildren(
      h('div.page-head', h('h1', 'Settings')),
      phonePanel(info),
      installPanel(),
      awayPanel(),
      libraryPanel(info, lib, draw),
      conversionPanel(info, lib),
      accountPanel(info),
      h('p.muted', { style: { fontSize: '13px' } }, `Movies ${info.version}`),
    );
    // Keep the conversion progress moving while this page is open.
    if (lib.jobs.length) setTimeout(() => root.isConnected && draw().catch(() => {}), 3000);
  };
  await draw();
  return root;
}
