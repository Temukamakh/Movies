import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { startServer } from './helpers.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

function makeVideo(file, args) {
  const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440', ...args, file]);
  assert.equal(r.status, 0, String(r.stderr));
}

test('files phones cannot play are converted to MP4, keeping subtitles and progress', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const s = await startServer({ password: 'pw123456', useFfmpeg: true });
  try {
    const dir = path.join(s.mediaDir, 'tv', 'Test Show', 'Season 1');
    await fs.mkdir(dir, { recursive: true });
    const srt = path.join(s.tmp, 'in.srt');
    await fs.writeFile(srt, '1\n00:00:00,500 --> 00:00:01,500\nEmbedded line\n');
    makeVideo(path.join(dir, 'Test.Show.S01E01.mkv'), ['-i', srt, '-t', '3', '-map', '0', '-map', '1', '-map', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', '-c:s', 'srt', '-metadata:s:s:0', 'language=eng']);
    makeVideo(path.join(dir, 'Test.Show.S01E02.avi'), ['-t', '3', '-c:v', 'mpeg4', '-c:a', 'mp3']);

    await s.json('/api/login', { password: 'pw123456' });
    await s.app.rescan();
    const before = (await s.json('/api/library')).body.items;
    const ep1 = before.find((i) => i.episode === 1);
    await s.json(`/api/progress/${ep1.id}`, { position: 1.2, duration: 3 });

    await s.app.idle();
    const { items } = (await s.json('/api/library')).body;
    assert.equal(items.length, 2);
    for (const item of items) {
      assert.equal(item.ext, 'mp4', `${item.fileName} converted`);
      assert.equal(item.status, 'ready');
      assert.ok(item.art, 'thumbnail made');
      assert.ok(item.duration > 2.5 && item.duration < 3.5);
    }
    const after = items.find((i) => i.episode === 1);
    assert.equal(after.id, ep1.id, 'same id after conversion');
    assert.equal(after.progress.position, 1.2, 'progress kept');
    assert.deepEqual(after.subtitles.map((t) => t.label), ['English']);
    const files = (await fs.readdir(dir)).sort();
    assert.deepEqual(files, ['Test.Show.S01E01.mp4', 'Test.Show.S01E02.mp4'], 'originals replaced, no temp files left');

    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', path.join(dir, 'Test.Show.S01E01.mp4')]);
    assert.deepEqual(String(probe.stdout).trim().split('\n'), ['h264', 'aac']);
    const vtt = await (await s.request(`/api/subtitles/${after.id}/${after.subtitles[0].id}.vtt`)).text();
    assert.match(vtt, /Embedded line/);
  } finally {
    await s.stop();
  }
});
