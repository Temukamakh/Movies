import fs from 'node:fs';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function sendJson(res, status, body, headers = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(json);
}

export async function readBody(req, limit) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > limit) throw new HttpError(413, 'That file is too large.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'That file is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Accepts application/json and text/plain (what navigator.sendBeacon sends). */
export async function readJson(req) {
  const buf = await readBody(req, 1024 * 1024);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Minimal router: route('GET', '/api/items/:id', handler). */
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, options = {}) {
    const keys = [];
    const regex = new RegExp(
      '^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$',
    );
    this.routes.push({ method, regex, keys, handler, options });
  }

  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.regex.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method && !(r.method === 'GET' && method === 'HEAD')) continue;
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { ...r, params };
    }
    return pathMatched ? { notAllowed: true } : null;
  }
}

/** Streams a file, honouring Range requests (required for seeking and for iPhone playback). */
export async function sendFile(req, res, file, { type, size, cache = 'private, no-cache' }) {
  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = /^bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range && (range[1] || range[2]) && size > 0) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), size - 1);
    } else {
      start = Math.max(0, size - Number(range[2]));
    }
    if (start >= size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    status = 206;
  }
  const headers = {
    'Content-Type': type,
    'Content-Length': Math.max(0, end - start + 1),
    'Accept-Ranges': 'bytes',
    'Cache-Control': cache,
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || size === 0) return res.end();
  await pipeline(fs.createReadStream(file, { start, end }), res).catch(() => {});
}

const normalizeIp = (ip = '') => ip.replace(/^::ffff:/, '');

export function isLoopback(ip) {
  ip = normalizeIp(ip);
  return ip === '::1' || ip.startsWith('127.');
}

export function isPrivateAddress(ip) {
  ip = normalizeIp(ip).toLowerCase();
  if (isLoopback(ip)) return true;
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  return /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip);
}

/** True when the request came through a reverse proxy or tunnel (e.g. cloudflared). */
export function isProxied(req) {
  const h = req.headers;
  return Boolean(h['x-forwarded-for'] || h['cf-connecting-ip'] || h['x-real-ip'] || h.forwarded);
}

export function clientAddress(req) {
  const socketIp = normalizeIp(req.socket.remoteAddress);
  if (isLoopback(socketIp) && isProxied(req)) {
    const h = req.headers;
    return h['cf-connecting-ip'] || h['x-real-ip'] || String(h['x-forwarded-for'] || '').split(',')[0].trim() || socketIp;
  }
  return socketIp;
}

/** Addresses other devices on the network can use to reach this computer. */
export function networkUrls(port) {
  const urls = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^(docker|br-|veth|virbr|vmnet|vboxnet)/.test(name)) continue;
      const tailscale = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address);
      urls.push({ url: `http://${a.address}:${port}`, label: tailscale ? 'Tailscale' : name });
    }
  }
  const rank = (u) => (u.url.includes('//192.168.') ? 0 : u.url.includes('//10.') ? 1 : u.label === 'Tailscale' ? 3 : 2);
  return urls.sort((a, b) => rank(a) - rank(b));
}
