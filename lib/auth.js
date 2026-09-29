import crypto from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { JsonStore } from './store.js';
import { parseCookies } from './http.js';

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'movies_session';
const SESSION_DAYS = 365;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [alg, salt, key] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scrypt(String(password), Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

/**
 * One shared password for the whole library. Sessions are signed cookies that last a
 * year, so a phone stays logged in; changing the password signs every device out.
 */
export class Auth {
  constructor({ dataDir, password }) {
    this.store = new JsonStore(path.join(dataDir, 'auth.json'), { hash: null, secret: null });
    this.envPassword = password || null;
    this.failures = new Map();
  }

  async init() {
    if (this.envPassword && !(this.configured && (await verifyPassword(this.envPassword, this.store.data.hash)))) {
      await this.setPassword(this.envPassword);
    }
  }

  get configured() {
    return Boolean(this.store.data.hash && this.store.data.secret);
  }

  async setPassword(password) {
    this.store.data.hash = await hashPassword(password);
    this.store.data.secret = crypto.randomBytes(32).toString('hex');
    this.store.flush();
  }

  check(password) {
    return this.configured ? verifyPassword(password, this.store.data.hash) : Promise.resolve(false);
  }

  sign(value) {
    return crypto.createHmac('sha256', this.store.data.secret).update(value).digest('base64url');
  }

  isAuthenticated(req) {
    if (!this.configured) return false;
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const [issued, sig] = String(token || '').split('.');
    if (!issued || !sig) return false;
    const expected = Buffer.from(this.sign(`session:${issued}`));
    const actual = Buffer.from(sig);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return false;
    const age = Date.now() - parseInt(issued, 36);
    return age >= 0 && age < SESSION_DAYS * 864e5;
  }

  /**
   * A signed, expiring token for one video's URL. AirPlay and Chromecast receivers fetch
   * the stream themselves without the browser's cookie, so the URL has to carry proof.
   * It changes once a day so URLs stay cacheable.
   */
  mediaToken(id, days = 7) {
    const expires = Math.ceil(Date.now() / 864e5) + days;
    return `${expires.toString(36)}.${this.sign(`media:${id}:${expires}`).slice(0, 22)}`;
  }

  checkMediaToken(id, token) {
    if (!this.configured) return false;
    const [e, sig] = String(token || '').split('.');
    const expires = parseInt(e, 36);
    if (!expires || !sig || expires < Date.now() / 864e5) return false;
    const expected = Buffer.from(this.sign(`media:${id}:${expires}`).slice(0, 22));
    const actual = Buffer.from(sig);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }

  sessionCookie(req) {
    const issued = Date.now().toString(36);
    return cookie(req, `${issued}.${this.sign(`session:${issued}`)}`, SESSION_DAYS * 86400);
  }

  clearCookie(req) {
    return cookie(req, '', 0);
  }

  isRateLimited(ip) {
    const f = this.failures.get(ip);
    if (f && Date.now() > f.until) this.failures.delete(ip);
    return (this.failures.get(ip)?.count ?? 0) >= MAX_FAILURES;
  }

  recordFailure(ip) {
    const f = this.failures.get(ip) ?? { count: 0, until: Date.now() + FAILURE_WINDOW_MS };
    f.count++;
    this.failures.set(ip, f);
  }

  clearFailures(ip) {
    this.failures.delete(ip);
  }
}

function cookie(req, value, maxAge) {
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
