#!/usr/bin/env node
import { createApp } from './lib/app.js';
import { loadConfig } from './lib/config.js';
import { networkUrls } from './lib/http.js';

const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  console.error(`Movies needs Node.js 18 or newer (you have ${process.version}). Get it from https://nodejs.org`);
  process.exit(1);
}

const config = loadConfig();
const app = await createApp(config);

app.server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`\nPort ${config.port} is already in use. Try: PORT=8081 npm start\n`);
  else console.error(err);
  process.exit(1);
});

app.server.listen(config.port, config.host, () => {
  const local = `http://localhost:${config.port}`;
  const phone = config.publicUrl ? [{ url: config.publicUrl }] : networkUrls(config.port);
  const lines = [
    '',
    '  Movies is running',
    '',
    `  On this computer:  ${local}`,
    ...phone.map((u, i) => `  ${i ? '                   ' : 'On your phone:     '}${u.url}${u.label === 'Tailscale' ? '  (Tailscale)' : ''}`),
    phone.length ? '                     (phone must be on the same Wi-Fi)' : '',
    '',
    `  Library folder:    ${config.mediaDir}`,
    `  ffmpeg:            ${app.media.available ? 'found - files phones cannot play get converted automatically' : 'not found - MKV/AVI files may not play on phones (see README)'}`,
    `  Library:           ${app.library.items.size} videos`,
    '',
    app.auth.configured ? '' : `  First time? Open ${local} to create your password.\n`,
  ];
  console.log(lines.filter((l, i, all) => l !== '' || all[i - 1] !== '').join('\n'));
});

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (closing) process.exit(1);
    closing = true;
    console.log('\nStopping…');
    await app.close();
    process.exit(0);
  });
}
