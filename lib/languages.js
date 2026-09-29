// Subtitle and audio languages: ISO 639 codes and English names to a label and a BCP-47 code.
const LANGUAGES = [
  ['en', 'eng', 'English'], ['es', 'spa', 'Spanish'], ['fr', 'fre', 'French', 'fra'],
  ['de', 'ger', 'German', 'deu'], ['it', 'ita', 'Italian'], ['pt', 'por', 'Portuguese'],
  ['ru', 'rus', 'Russian'], ['ka', 'geo', 'Georgian', 'kat'], ['uk', 'ukr', 'Ukrainian'],
  ['pl', 'pol', 'Polish'], ['nl', 'dut', 'Dutch', 'nld'], ['sv', 'swe', 'Swedish'],
  ['no', 'nor', 'Norwegian', 'nob'], ['da', 'dan', 'Danish'], ['fi', 'fin', 'Finnish'],
  ['tr', 'tur', 'Turkish'], ['el', 'gre', 'Greek', 'ell'], ['cs', 'cze', 'Czech', 'ces'],
  ['hu', 'hun', 'Hungarian'], ['ro', 'rum', 'Romanian', 'ron'], ['bg', 'bul', 'Bulgarian'],
  ['hr', 'hrv', 'Croatian'], ['sr', 'srp', 'Serbian'], ['ar', 'ara', 'Arabic'],
  ['he', 'heb', 'Hebrew'], ['fa', 'per', 'Persian', 'fas'], ['hi', 'hin', 'Hindi'],
  ['ja', 'jpn', 'Japanese'], ['ko', 'kor', 'Korean'], ['zh', 'chi', 'Chinese', 'zho'],
  ['th', 'tha', 'Thai'], ['vi', 'vie', 'Vietnamese'], ['id', 'ind', 'Indonesian'],
  ['ms', 'may', 'Malay', 'msa'], ['hy', 'arm', 'Armenian', 'hye'], ['az', 'aze', 'Azerbaijani'],
];

const LOOKUP = new Map();
for (const [code, alt, name, alt2] of LANGUAGES) {
  for (const key of [code, alt, name.toLowerCase(), alt2].filter(Boolean)) LOOKUP.set(key, { lang: code, name });
}

/** "en" / "eng" / "English" -> { lang: 'en', name: 'English' } */
export function language(value) {
  return LOOKUP.get(String(value || '').toLowerCase()) ?? null;
}

/** Finds a language inside a free-form label such as "English (SDH)" or "movie.en.forced". */
export function languageFromLabel(label) {
  for (const word of String(label).toLowerCase().split(/[^a-z]+/)) {
    const hit = word.length >= 2 && LOOKUP.get(word);
    if (hit) return hit;
  }
  return null;
}
