// Watch-state rules shared by the views and the player.

/** Same rule as the server: 93% through, or the last minute of anything over 5 minutes. */
export function isWatched(position, duration) {
  return duration > 0 && position > 0 && (position / duration >= 0.93 || (duration > 300 && duration - position < 60));
}

export const inProgress = (item) => Boolean(item.progress && !item.progress.watched && item.progress.position >= 10);
export const watched = (item) => Boolean(item.progress?.watched);

export function fraction(item) {
  const d = item.progress?.duration || item.duration;
  return d ? Math.min(1, (item.progress?.position || 0) / d) : 0;
}

export function remaining(item) {
  const d = item.progress?.duration || item.duration;
  return d ? Math.max(0, d - (item.progress?.position || 0)) : null;
}

export function nextEpisode(show, item) {
  const i = show.episodes.findIndex((e) => e.id === item.id);
  return i >= 0 ? (show.episodes[i + 1] ?? null) : null;
}

/**
 * What the big button on a show should do:
 * resume the episode you're in the middle of, start the one after the last you finished,
 * or start from the top.
 */
export function upNext(show) {
  const eps = show.episodes;
  const latest = eps.filter((e) => e.progress).sort((a, b) => b.progress.updatedAt - a.progress.updatedAt)[0];
  if (!latest) return { episode: eps[0], mode: 'start' };
  if (!latest.progress.watched) return { episode: latest, mode: 'resume', updatedAt: latest.progress.updatedAt };
  const after = eps.slice(eps.indexOf(latest) + 1).find((e) => !watched(e));
  const any = after ?? eps.find((e) => !watched(e));
  if (any) return { episode: any, mode: inProgress(any) ? 'resume' : 'next', updatedAt: latest.progress.updatedAt };
  return { episode: eps[0], mode: 'rewatch' };
}

export function continueWatching(lib) {
  const entries = lib.movies.filter(inProgress).map((item) => ({ item, updatedAt: item.progress.updatedAt }));
  for (const show of lib.shows) {
    const next = upNext(show);
    if (next.mode === 'resume' || next.mode === 'next') entries.push({ item: next.episode, show, upNext: next.mode === 'next', updatedAt: next.updatedAt });
  }
  return entries.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);
}

export function recentlyAdded(lib, limit = 16) {
  return [
    ...lib.movies.map((m) => ({ movie: m, addedAt: m.addedAt })),
    ...lib.shows.map((s) => ({ show: s, addedAt: s.addedAt })),
  ].sort((a, b) => b.addedAt - a.addedAt).slice(0, limit);
}

const sortKey = (title) => String(title).toLowerCase().replace(/^(the|a|an)\s+/, '');
export const byTitle = (a, b) => sortKey(a.title).localeCompare(sortKey(b.title), undefined, { numeric: true });

export function matches(query, ...fields) {
  const q = query.trim().toLowerCase();
  return !q || fields.some((f) => String(f ?? '').toLowerCase().includes(q));
}
