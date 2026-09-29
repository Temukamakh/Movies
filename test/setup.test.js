import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startServer } from './helpers.js';

test('first run: the password can only be created from the home network', async () => {
  const s = await startServer();
  try {
    assert.deepEqual((await s.json('/api/session')).body, { authenticated: false, configured: false, canSetup: true });
    // Requests through a tunnel (e.g. cloudflared on localhost) carry forwarding headers.
    const viaTunnel = await s.request('/api/setup', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' }, body: JSON.stringify({ password: 'sneaky123' }),
    });
    assert.equal(viaTunnel.status, 403);
    assert.equal((await s.json('/api/setup', { password: '123' })).status, 400, 'too short');
    assert.equal((await s.json('/api/setup', { password: 'popcorn!' })).status, 200);
    assert.equal((await s.json('/api/session')).body.authenticated, true);
    assert.equal((await s.json('/api/setup', { password: 'again123' })).status, 409);

    assert.equal((await s.json('/api/password', { current: 'wrong', next: 'newpass1' })).status, 400);
    assert.equal((await s.json('/api/password', { current: 'popcorn!', next: 'newpass1' })).status, 200);
    s.logout();
    assert.equal((await s.json('/api/login', { password: 'popcorn!' })).status, 401);
    assert.equal((await s.json('/api/login', { password: 'newpass1' })).status, 200);
  } finally {
    await s.stop();
  }
});

test('repeated wrong passwords are rate limited', async () => {
  const s = await startServer({ password: 'right-one' });
  try {
    for (let i = 0; i < 10; i++) assert.equal((await s.json('/api/login', { password: 'x' })).status, 401);
    assert.equal((await s.json('/api/login', { password: 'right-one' })).status, 429);
  } finally {
    await s.stop();
  }
});
