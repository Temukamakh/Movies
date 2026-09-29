import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../lib/app.js';
import { loadConfig } from '../lib/config.js';

/** Starts a server on a random port with its own temporary media and data folders. */
export async function startServer({ files = {}, ...options } = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'movies-test-'));
  const mediaDir = path.join(tmp, 'media');
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(mediaDir, rel)), { recursive: true });
    await fs.writeFile(path.join(mediaDir, rel), content);
  }
  const app = await createApp(loadConfig({
    mediaDir, dataDir: path.join(tmp, 'data'), port: 0, useFfmpeg: false, quiet: true, ...options,
  }));
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = '';
  const request = async (p, opts = {}) => {
    const res = await fetch(base + p, { ...opts, headers: { ...(cookie ? { cookie } : {}), ...opts.headers } });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return res;
  };
  const json = async (p, body, method = body === undefined ? 'GET' : 'POST') => {
    const res = await request(p, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return {
    app, base, tmp, mediaDir, request, json,
    logout: () => (cookie = ''),
    async stop() {
      await app.close();
      await fs.rm(tmp, { recursive: true, force: true });
    },
  };
}
