import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseName, seasonFromFolder } from '../public/js/parse.js';

const movie = (title, year) => ({ kind: 'movie', title, year });
const episode = (show, season, ep, title) => ({ kind: 'episode', show, season, episode: ep, title });
const pick = (r) => (r.kind === 'movie'
  ? { kind: r.kind, title: r.title, year: r.year }
  : { kind: r.kind, show: r.show, season: r.season, episode: r.episode, title: r.title });

test('movie names', () => {
  const cases = {
    'Inception.2010.1080p.BluRay.x264-SPARKS.mkv': movie('Inception', 2010),
    'The Matrix (1999) [1080p] [YTS.MX].mp4': movie('The Matrix', 1999),
    '1917.2019.1080p.mkv': movie('1917', 2019),
    '2012.mkv': movie('2012', null),
    'Blade.Runner.2049.2017.2160p.mkv': movie('Blade Runner 2049', 2017),
    'my holiday video.mp4': movie('My Holiday Video', null),
    'Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX.mkv': movie('Dune Part Two', 2024),
    'Star.Wars.Episode.IV.A.New.Hope.1977.mkv': movie('Star Wars Episode IV A New Hope', 1977),
    'Movie Name 720p.mkv': movie('Movie Name', null),
  };
  for (const [name, expected] of Object.entries(cases)) assert.deepEqual(pick(parseName(name)), expected, name);
});

test('episode names', () => {
  const cases = {
    'Breaking.Bad.S01E01.Pilot.720p.BluRay.x264.mkv': episode('Breaking Bad', 1, 1, 'Pilot'),
    'friends 1x05 the one with.avi': episode('Friends', 1, 5, 'The One with'),
    'Doctor.Who.2005.S01E01.Rose.mkv': episode('Doctor Who', 1, 1, 'Rose'),
    'Mr. Robot S01E01.mkv': episode('Mr. Robot', 1, 1, ''),
    'The.Office.US.S02E01E02.The.Dundies.720p.WEB-DL.mkv': episode('The Office US', 2, 1, 'The Dundies'),
    'Show - S03E10 - Finale.mp4': episode('Show', 3, 10, 'Finale'),
  };
  for (const [name, expected] of Object.entries(cases)) assert.deepEqual(pick(parseName(name)), expected, name);
});

test('looser episode patterns only when the file is known to be TV', () => {
  assert.equal(parseName('05 - The Rains of Castamere.mkv').kind, 'movie');
  assert.deepEqual(pick(parseName('05 - The Rains of Castamere.mkv', { tv: true })), episode('', null, 5, 'The Rains of Castamere'));
  assert.equal(parseName('Episode 3.mp4', { tv: true }).episode, 3);
});

test('season folders', () => {
  assert.equal(seasonFromFolder('Season 2'), 2);
  assert.equal(seasonFromFolder('S03'), 3);
  assert.equal(seasonFromFolder('Season.10.1080p'), 10);
  assert.equal(seasonFromFolder('Extras'), null);
});
