// Guesses what a video file is from its name. Shared by the server (library scan)
// and the browser (upload form defaults) so both agree on titles and episode numbers.

export const VIDEO_EXTENSIONS = new Set([
  'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'ts', 'm2ts', 'mts',
  'mpg', 'mpeg', '3gp', 'ogv', 'divx',
]);
export const SUBTITLE_EXTENSIONS = new Set(['srt', 'vtt']);

export function extname(name) {
  const m = /\.([^./\\]+)$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}
export const stripExt = (name) => name.replace(/\.[^./\\]+$/, '');
export const basename = (p) => p.split(/[/\\]/).pop();
export const isVideo = (name) => VIDEO_EXTENSIONS.has(extname(name));
export const isSubtitle = (name) => SUBTITLE_EXTENSIONS.has(extname(name));

// Release tags that never belong to a title. Short words that can appear in real
// titles ("web", "cam", "ts") are left out on purpose.
const RELEASE_TAG = /\b(?:2160p|1440p|1080[pi]|720p|576p|480p|4k|uhd|hdr(?:10)?|dolby vision|blu[ -]?ray|bdrip|brrip|bdremux|remux|web[ -]?dl|web[ -]?rip|hdtv|hdrip|dvdrip|dvdscr|x ?26[45]|h ?26[45]|hevc|xvid|divx|10 ?bit|aac|e?ac3|ddp?5 1|dts|truehd|atmos|proper|repack|extended|unrated|remastered|imax|yts|yify|rarbg)\b/i;
const SEASON_EPISODE = /\bs(\d{1,2})[ -]*e(\d{1,3})(?:[ -]*e\d{1,3})*\b/i;
const CROSS_EPISODE = /\b(\d{1,2})x(\d{2,3})\b/i;
const EPISODE_ONLY = /\b(?:e|ep|episode)[ -]*(\d{1,3})\b/i;
const LEADING_NUMBER = /^(\d{1,3})\b/;
const SEASON_FOLDER = /^(?:season|series|staffel|saison|temporada)[ -]*(\d{1,2})\b|^s(\d{1,2})$/i;

const maxYear = () => new Date().getFullYear() + 1;

// "The.Matrix.(1999).[1080p]" -> "The Matrix (1999) "
function normalize(s) {
  return s
    .replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ')
    .replace(/_|\.(?!\s)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cutAtTag(s) {
  const m = RELEASE_TAG.exec(s);
  return m && m.index > 0 ? s.slice(0, m.index) : s;
}

function titleCase(s) {
  if (s !== s.toLowerCase()) return s;
  const small = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'vs', 'with']);
  return s.replace(/\S+/g, (w, i) => (i > 0 && small.has(w) ? w : w[0].toUpperCase() + w.slice(1)));
}

export function tidy(s) {
  return titleCase(
    s.replace(/\s*\(\s*\)\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[\s\-–—:,.(\[]+|[\s\-–—:,(\[]+$/g, '')
      .trim(),
  );
}

// "Doctor Who 2005" -> "Doctor Who"
function stripTrailingYear(s) {
  return s.replace(/[\s(]*(?:19|20)\d{2}\)?\s*$/, '');
}

/** Finds the release year, ignoring a year that starts the title ("2012", "1917"). */
function findYear(s) {
  let best = null;
  for (const m of s.matchAll(/(^|[\s(])((?:19|20)\d{2})(?=$|[\s)])/g)) {
    const start = m.index + m[1].length;
    if (start > 0 && Number(m[2]) <= maxYear()) best = { year: Number(m[2]), start };
  }
  return best;
}

export function seasonFromFolder(name) {
  const m = SEASON_FOLDER.exec(normalize(name));
  return m ? Number(m[1] ?? m[2]) : null;
}

/**
 * Parses a file or folder name.
 * @param {string} name  file name (extension optional)
 * @param {{ tv?: boolean }} hints  tv: the file is known to be an episode, so looser
 *   patterns like "Episode 5" or "05 - Title" are accepted.
 * @returns {{ kind: 'movie'|'episode', title: string, year: number|null,
 *   show: string, season: number|null, episode: number|null }}
 */
export function parseName(name, hints = {}) {
  const raw = isVideo(name) || isSubtitle(name) ? stripExt(basename(name)) : basename(name);
  const s = normalize(raw);

  const se = SEASON_EPISODE.exec(s) || CROSS_EPISODE.exec(s);
  if (se) {
    return {
      kind: 'episode',
      show: tidy(stripTrailingYear(s.slice(0, se.index))),
      season: Number(se[1]),
      episode: Number(se[2]),
      title: tidy(cutAtTag(s.slice(se.index + se[0].length))),
      year: null,
    };
  }

  if (hints.tv) {
    const ep = EPISODE_ONLY.exec(s) || LEADING_NUMBER.exec(s);
    if (ep) {
      return {
        kind: 'episode',
        show: tidy(stripTrailingYear(s.slice(0, ep.index))),
        season: null,
        episode: Number(ep[1]),
        title: tidy(cutAtTag(s.slice(ep.index + ep[0].length))),
        year: null,
      };
    }
    return { kind: 'episode', show: '', season: null, episode: null, title: tidy(cutAtTag(s)) || raw, year: null };
  }

  const y = findYear(s);
  const title = tidy(cutAtTag(y ? s.slice(0, y.start) : s));
  return { kind: 'movie', title: title || tidy(s) || raw, year: y ? y.year : null, show: '', season: null, episode: null };
}
