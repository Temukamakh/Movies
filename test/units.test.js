import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isWatched, srtToVtt } from '../lib/app.js';
import { subtitleFileLabel } from '../lib/library.js';
import { planFor } from '../lib/media.js';
import { destinationFor, safeName } from '../lib/uploads.js';

test('a video counts as watched near the end', () => {
  assert.equal(isWatched(50, 100), false);
  assert.equal(isWatched(94, 100), true);
  assert.equal(isWatched(6000, 6600), false);
  assert.equal(isWatched(6560, 6600), true); // last minute of a long film
  assert.equal(isWatched(0, 20), false);
  assert.equal(isWatched(10, 0), false);
});

test('SRT becomes WebVTT', () => {
  const vtt = srtToVtt('﻿1\r\n00:00:01,000 --> 00:00:04,500\r\n{\\an8}Hello\r\n');
  assert.equal(vtt, 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.500\nHello\n');
  assert.ok(srtToVtt('WEBVTT\n\n00:01.000 --> 00:02.000\nHi').startsWith('WEBVTT\n\n00:01.000'));
});

test('subtitle labels come from the end of the file name', () => {
  assert.deepEqual(subtitleFileLabel('Movie.2010.en.srt'), { label: 'English', lang: 'en' });
  assert.deepEqual(subtitleFileLabel('Movie.English.SDH.srt'), { label: 'English (SDH)', lang: 'en' });
  assert.deepEqual(subtitleFileLabel('Film.ka.srt'), { label: 'Georgian', lang: 'ka' });
  assert.deepEqual(subtitleFileLabel('It.Follows.2014.srt'), { label: 'Subtitles', lang: '' });
});

test('playability decisions', () => {
  const h264 = { index: 0, codec: 'h264', profile: 'High', pixFmt: 'yuv420p', tag: 'avc1' };
  const aac = { index: 1, codec: 'aac' };
  assert.equal(planFor({ video: h264, audio: aac }, 'mp4').playable, true);

  const mkv = planFor({ video: h264, audio: { index: 1, codec: 'ac3' } }, 'mkv');
  assert.equal(mkv.playable, false);
  assert.equal(mkv.video, 'copy');
  assert.equal(mkv.audio, 'transcode');

  const hevc = planFor({ video: { index: 0, codec: 'hevc', tag: 'hev1' }, audio: aac }, 'mp4');
  assert.equal(hevc.playable, false, 'hev1-tagged HEVC needs a remux for iPhone');
  assert.equal(hevc.video, 'copy');
  assert.equal(hevc.hevc, true);

  const xvid = planFor({ video: { index: 0, codec: 'mpeg4' }, audio: { index: 1, codec: 'mp3' } }, 'avi');
  assert.equal(xvid.video, 'transcode');
  assert.equal(xvid.audio, 'copy');

  const hi10 = planFor({ video: { ...h264, profile: 'High 10', pixFmt: 'yuv420p10le' }, audio: aac }, 'mp4');
  assert.equal(hi10.playable, false);
  assert.equal(hi10.video, 'transcode');

  assert.equal(planFor({ video: { index: 0, codec: 'vp8' }, audio: { index: 1, codec: 'opus' } }, 'webm').playable, true);
});

test('uploads get tidy, safe file names', () => {
  assert.equal(safeName('Dune: Part Two'), 'Dune - Part Two');
  assert.equal(safeName('../../etc/passwd'), 'etc passwd');
  assert.equal(safeName('CON'), 'CON_');
  const sep = (p) => p.split(/[\\/]/).join('/');
  assert.equal(sep(destinationFor('x.mkv', { kind: 'movie', title: 'Heat', year: 1995 })), 'movies/Heat (1995).mkv');
  assert.equal(sep(destinationFor('x.mp4', { kind: 'episode', show: 'Lost', season: 1, episode: 4, title: 'Walkabout' })), 'tv/Lost/Season 1/Lost - S01E04 - Walkabout.mp4');
  assert.equal(sep(destinationFor('bonus clip.mp4', { kind: 'episode', show: 'Lost', season: null, episode: null, title: '' })), 'tv/Lost/bonus clip.mp4');
});
