let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => (onUnauthorized = fn);

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

/** JSON API call. `raw` sends a Blob/string body as-is. */
export async function api(path, { method = 'GET', body, raw, headers = {} } = {}) {
  const opts = { method, headers: { ...headers }, credentials: 'same-origin' };
  if (raw !== undefined) opts.body = raw;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`/api${path}`, opts);
  } catch {
    throw new ApiError("Can't reach the server. Is it still running?", 0);
  }
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json().catch(() => null) : null;
  if (res.status === 401 && !path.startsWith('/login') && !path.startsWith('/session')) onUnauthorized();
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data);
  return data;
}

// ---------------------------------------------------------------- library cache

let library = null;
let fetchedAt = 0;
let pending = null;

function index(raw) {
  const items = new Map(raw.items.map((i) => [i.id, i]));
  const shows = raw.shows
    .map((s) => ({ ...s, episodes: s.episodeIds.map((id) => items.get(id)).filter(Boolean) }))
    .filter((s) => s.episodes.length);
  return {
    items,
    shows,
    showById: new Map(shows.map((s) => [s.id, s])),
    movies: raw.items.filter((i) => i.kind === 'movie'),
    jobs: raw.jobs,
    ffmpeg: raw.ffmpeg,
  };
}

export function getLibrary({ force = false } = {}) {
  if (!force && library && Date.now() - fetchedAt < 5000) return Promise.resolve(library);
  pending ??= api('/library')
    .then((raw) => {
      library = index(raw);
      fetchedAt = Date.now();
      return library;
    })
    .finally(() => (pending = null));
  return pending;
}

/** The library, refetched if it doesn't know `id` yet (e.g. a file added moments ago). */
export async function libraryWith(id) {
  const lib = await getLibrary();
  return lib.items.has(id) || lib.showById.has(id) ? lib : getLibrary({ force: true });
}

export const cachedLibrary = () => library;
export const invalidate = () => (fetchedAt = 0);
