// Small DOM helpers shared by every view.

const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'muted', 'textContent', 'hidden', 'multiple', 'accept']);

/** h('div.card', { onClick }, child, 'text', [more]) */
export function h(tag, props, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (props == null || typeof props !== 'object' || props instanceof Node || Array.isArray(props)) {
    children.unshift(props);
    props = {};
  }
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.classList.add(...String(v).split(' ').filter(Boolean));
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false || c === '') continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const ICONS = {
  home: '<path d="M3.5 10.2 12 3.5l8.5 6.7V19a1.5 1.5 0 0 1-1.5 1.5h-4.2v-6h-5.6v6H5A1.5 1.5 0 0 1 3.5 19z"/>',
  film: '<rect x="3" y="3.5" width="18" height="17" rx="2.5"/><path d="M7.5 3.5v17M16.5 3.5v17M3 8.5h4.5M3 15.5h4.5M16.5 8.5H21M16.5 15.5H21M7.5 12h9"/>',
  tv: '<rect x="2.5" y="6" width="19" height="13.5" rx="2.5"/><path d="m8 2.5 4 3.5 4-3.5"/>',
  upload: '<path d="M12 15.5V4M7 8.5 12 3.5l5 5M4.5 15v3a2.5 2.5 0 0 0 2.5 2.5h10a2.5 2.5 0 0 0 2.5-2.5v-3"/>',
  settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/>',
  play: '<path d="M7 4.8v14.4a1 1 0 0 0 1.5.86l12-7.2a1 1 0 0 0 0-1.72l-12-7.2A1 1 0 0 0 7 4.8z"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  back: '<path d="M15 5 8 12l7 7"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  more: '<circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/>',
  edit: '<path d="M4 20h4.5L19.3 9.2a2.1 2.1 0 0 0-3-3L5.5 17v3z"/><path d="m14.5 8 2.5 2.5"/>',
  trash: '<path d="M4.5 7h15M10 11v6M14 11v6M6.5 7l.9 12.1A1.5 1.5 0 0 0 8.9 20.5h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7M9.5 7V4.5h5V7"/>',
  cc: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M10 10.2a2.3 2.3 0 1 0 0 3.6M17 10.2a2.3 2.3 0 1 0 0 3.6"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  restart: '<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5"/><path d="M4 4v4.5h4.5"/>',
  next: '<path d="M5.5 5.5v13l9.5-6.5zM18.5 5.5v13"/>',
  phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M11 18h2"/>',
  refresh: '<path d="M20 12a8 8 0 0 1-14.3 4.9M4 12a8 8 0 0 1 14.3-4.9"/><path d="M18.5 3v4.2h-4.2M5.5 21v-4.2h4.2"/>',
  image: '<rect x="3" y="3.5" width="18" height="17" rx="2.5"/><circle cx="9" cy="9.5" r="1.8"/><path d="m21 15.5-5-5-9.5 10"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  logout: '<path d="M14.5 4.5h3a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-3M10 16.5 5.5 12 10 7.5M5.5 12h10"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.3v.2"/>',
  folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  eyeOff: '<path d="M3 3l18 18M10.6 5.6A9.7 9.7 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.9 3.6M6.4 6.9C3.9 8.6 2.5 12 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4-1"/><path d="M9.9 10a2.8 2.8 0 0 0 4 4"/>',
  wand: '<path d="m4 20 11-11M14 4v3M12.5 5.5h3M19 9v3M17.5 10.5h3M18 3.5v2M17 4.5h2"/><path d="m13.5 7.5 3 3"/>',
};

export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] ?? '';
  return svg;
}

export const brandMark = () => h('span.brand-mark', icon('play'));

// ---------------------------------------------------------------- formatting

/** 3725 -> "1:02:05", 95 -> "1:35" */
export function clock(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** 6720 -> "1h 52m", 1500 -> "25m" */
export function duration(sec) {
  if (!sec) return '';
  const m = Math.round(sec / 60);
  if (m < 1) return `${Math.round(sec)}s`;
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60 ? `${m % 60}m` : ''}`.trim() : `${m}m`;
}

export function bytes(n) {
  if (!n && n !== 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) (n /= 1024), i++;
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

export function hue(text) {
  let x = 0;
  for (const c of String(text)) x = (x * 31 + c.codePointAt(0)) >>> 0;
  return x % 360;
}

export const pad2 = (n) => String(n).padStart(2, '0');
export const episodeCode = (e) => `S${e.season}${e.episode != null ? ` · E${e.episode}` : ''}`;

// ---------------------------------------------------------------- artwork

/** A 16:9 thumbnail with a generated fallback when there's no picture yet. */
export function artwork(url, title, extra = []) {
  const box = h('div.thumb');
  const fallback = () => h('div.art-fallback', { style: { '--hue': hue(title) } }, h('span', title));
  if (url) {
    const img = h('img', { src: url, alt: '', loading: 'lazy', decoding: 'async' });
    img.addEventListener('error', () => img.replaceWith(fallback()), { once: true });
    box.append(img);
  } else {
    box.append(fallback());
  }
  box.style.setProperty('--hue', hue(title));
  return append(box, extra);
}

export function progressBar(fraction) {
  return h('div.bar', h('i', { style: { width: `${Math.min(100, Math.max(2, fraction * 100))}%` } }));
}

// ---------------------------------------------------------------- overlays

let openModal = null;

export function closeModal() {
  openModal?.remove();
  openModal = null;
  document.removeEventListener('keydown', onModalKey);
}

function onModalKey(e) {
  if (e.key === 'Escape') closeModal();
}

/** Opens a dialog. `content` is an array of nodes; returns the dialog element. */
export function modal(content, { label = 'Dialog' } = {}) {
  closeModal();
  const dialog = h('div.modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': label }, content);
  const backdrop = h('div.modal-backdrop', { onClick: (e) => e.target === backdrop && closeModal() }, dialog);
  document.body.append(backdrop);
  openModal = backdrop;
  document.addEventListener('keydown', onModalKey);
  requestAnimationFrame(() => dialog.querySelector('input, button.primary, button')?.focus({ preventScroll: true }));
  return dialog;
}

/** A list of actions: [{ label, icon, onClick, danger, on }] */
export function sheet(title, actions) {
  return modal(
    [
      title && h('h3', title),
      h('div.sheet-list', actions.filter(Boolean).map((a) =>
        h(`button${a.danger ? '.danger' : ''}${a.on ? '.on' : ''}`, {
          type: 'button',
          onClick: () => (closeModal(), a.onClick()),
        }, icon(a.icon ?? 'check'), a.label),
      )),
    ],
    { label: title || 'Actions' },
  );
}

export function confirm({ title, message, confirmLabel = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const done = (value) => (closeModal(), resolve(value));
    modal([
      h('h3', title),
      message && h('p', message),
      h('div.modal-actions',
        h('button.btn.ghost', { type: 'button', onClick: () => done(false) }, 'Cancel'),
        h(`button.btn.${danger ? 'danger' : 'primary'}`, { type: 'button', onClick: () => done(true) }, confirmLabel),
      ),
    ], { label: title });
  });
}

/**
 * A small form in a dialog. fields: [{ name, label, value, type, placeholder, list }]
 * onSubmit(values) may throw to show an error and keep the dialog open.
 */
export function formDialog({ title, message, fields, submitLabel = 'Save', onSubmit, extra }) {
  const error = h('div.error', { role: 'alert' });
  const inputs = {};
  const form = h('form.form-grid', {
    onSubmit: async (e) => {
      e.preventDefault();
      const values = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value.trim()]));
      submit.disabled = true;
      error.textContent = '';
      try {
        await onSubmit(values);
        closeModal();
      } catch (err) {
        error.textContent = err.message;
        submit.disabled = false;
      }
    },
  });
  const rows = [];
  for (const f of fields) {
    const input = (inputs[f.name] = h('input', {
      type: f.type ?? 'text',
      value: f.value ?? '',
      placeholder: f.placeholder,
      inputmode: f.type === 'number' ? 'numeric' : undefined,
      autocomplete: f.autocomplete ?? 'off',
      list: f.list,
      required: f.required,
      min: f.min,
    }));
    const field = h('label.field', h('span', f.label), input);
    if (f.half) {
      const last = rows.at(-1);
      if (last?.classList.contains('row2') && last.children.length < 2) last.append(field);
      else rows.push(h('div.row2', field));
    } else rows.push(field);
  }
  const submit = h('button.btn.primary', { type: 'submit' }, submitLabel);
  append(form, [rows, extra, error, h('div.modal-actions', h('button.btn.ghost', { type: 'button', onClick: closeModal }, 'Cancel'), submit)]);
  return modal([h('h3', title), message && h('p', message), form], { label: title });
}

let toastTimer;
export function toast(message, action) {
  document.querySelector('.toast')?.remove();
  clearTimeout(toastTimer);
  const el = h('div.toast', { role: 'status' }, h('span', message),
    action && h('button', { type: 'button', onClick: () => (el.remove(), action.onClick()) }, action.label));
  document.body.append(el);
  toastTimer = setTimeout(() => el.remove(), action ? 6000 : 3500);
}

/** Opens a file picker and resolves with the chosen files. */
export function pickFiles({ accept, multiple = false, directory = false } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple, style: { display: 'none' } });
    if (directory) input.setAttribute('webkitdirectory', '');
    input.addEventListener('change', () => (resolve([...input.files]), input.remove()));
    document.body.append(input);
    input.click();
  });
}

/** Scales a picture down and re-encodes it as JPEG (the server only stores JPEGs). */
export async function imageToJpeg(file, maxWidth = 1280) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("That picture couldn't be opened."));
      i.src = url;
    });
    const scale = Math.min(1, maxWidth / img.naturalWidth);
    const canvas = h('canvas', { width: Math.round(img.naturalWidth * scale), height: Math.round(img.naturalHeight * scale) });
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Grabs the current frame of a playing <video> as a JPEG blob. */
export function captureFrame(video, maxWidth = 640) {
  if (!video.videoWidth) return Promise.resolve(null);
  const scale = Math.min(1, maxWidth / video.videoWidth);
  const canvas = h('canvas', { width: Math.round(video.videoWidth * scale), height: Math.round(video.videoHeight * scale) });
  try {
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
  } catch {
    return Promise.resolve(null);
  }
}
