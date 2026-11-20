'use strict';
// Autenticação de usuário único.
// - Senha guardada apenas como hash scrypt (N=2^15) em variável de ambiente.
// - Sessão: cookie HttpOnly assinado com HMAC-SHA256 (stateless).
// - Bloqueio progressivo por IP + atraso global contra força bruta.
// - 2FA TOTP (RFC 6238) opcional, ativado quando TOTP_SECRET existe.
const crypto = require('crypto');
const { config } = require('../config');

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };
const COOKIE = 'orx_sid';

function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(plain, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(plain, stored) {
  try {
    const [alg, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const got = crypto.scryptSync(String(plain), Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
    });
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  } catch {
    return false;
  }
}

function safeEqualStr(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------- TOTP ----------
function base32Decode(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of s.replace(/=+$/, '')) {
    const v = alphabet.indexOf(ch);
    if (v < 0) throw new Error('base32 inválido');
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totpAt(secretB32, counter) {
  const key = base32Decode(secretB32);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h.readUInt32BE(off) & 0x7fffffff) % 1e6).toString().padStart(6, '0');
  return code;
}

function verifyTotp(secretB32, token) {
  if (!/^\d{6}$/.test(String(token || ''))) return false;
  const now = Math.floor(Date.now() / 1000 / 30);
  for (let w = -1; w <= 1; w++) if (safeEqualStr(totpAt(secretB32, now + w), token)) return true;
  return false;
}

// ---------- Sessão ----------
function sign(payloadB64) {
  return crypto.createHmac('sha256', config.auth.sessionSecret).update(payloadB64).digest('base64url');
}

function issueSession(res, req) {
  const now = Date.now();
  const payload = { u: config.auth.user, iat: now, exp: now + config.auth.sessionHours * 3600e3, n: crypto.randomBytes(8).toString('hex') };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const value = `${b64}.${sign(b64)}`;
  res.cookie(COOKIE, value, {
    httpOnly: true,
    secure: config.isProd || req.secure,
    sameSite: 'strict',
    path: '/',
    maxAge: config.auth.sessionHours * 3600e3,
  });
}

function readSession(req) {
  const raw = parseCookies(req.headers.cookie || '')[COOKIE];
  if (!raw || !raw.includes('.')) return null;
  const [b64, sig] = raw.split('.');
  const expected = sign(b64);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const p = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    if (!p.exp || p.exp < Date.now() || p.u !== config.auth.user) return null;
    return p;
  } catch {
    return null;
  }
}

function clearSession(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

function parseCookies(header) {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ---------- Anti força bruta ----------
const attempts = new Map(); // ip -> { fails, lockUntil, last }
let globalFails = [];

function lockStatus(ip) {
  const a = attempts.get(ip);
  if (a && a.lockUntil > Date.now()) return Math.ceil((a.lockUntil - Date.now()) / 1000);
  return 0;
}

function registerFail(ip) {
  const a = attempts.get(ip) || { fails: 0, lockUntil: 0 };
  a.fails += 1;
  a.last = Date.now();
  // 5 falhas -> 15 min; 10 -> 1 h; 15+ -> 6 h
  if (a.fails >= 15) a.lockUntil = Date.now() + 6 * 3600e3;
  else if (a.fails >= 10) a.lockUntil = Date.now() + 3600e3;
  else if (a.fails >= 5) a.lockUntil = Date.now() + 15 * 60e3;
  attempts.set(ip, a);
  const cutoff = Date.now() - 3600e3;
  globalFails = globalFails.filter((t) => t > cutoff);
  globalFails.push(Date.now());
}

function registerSuccess(ip) {
  attempts.delete(ip);
}

function globalDelayMs() {
  // Muitas falhas na última hora (de qualquer IP) => atraso para todos.
  return globalFails.length > 20 ? 2000 : 0;
}

// limpeza periódica
setInterval(() => {
  const cutoff = Date.now() - 24 * 3600e3;
  for (const [ip, a] of attempts) if ((a.last || 0) < cutoff && a.lockUntil < Date.now()) attempts.delete(ip);
}, 3600e3).unref();

async function login(req, res) {
  const ip = req.ip;
  const wait = lockStatus(ip);
  if (wait) return res.status(429).json({ ok: false, error: `Muitas tentativas. Tente novamente em ${Math.ceil(wait / 60)} min.` });

  const { user, pass, totp } = req.body || {};
  const delay = 400 + Math.random() * 300 + globalDelayMs(); // resposta em tempo ~constante
  const started = Date.now();

  const userOk = typeof user === 'string' && safeEqualStr(user.trim().toLowerCase(), config.auth.user);
  const passOk = typeof pass === 'string' && pass.length <= 256 && verifyPassword(pass, config.auth.passHash);
  const totpOk = !config.auth.totpSecret || verifyTotp(config.auth.totpSecret, totp);

  const elapsed = Date.now() - started;
  if (elapsed < delay) await new Promise((r) => setTimeout(r, delay - elapsed));

  if (userOk && passOk && totpOk) {
    registerSuccess(ip);
    issueSession(res, req);
    return res.json({ ok: true });
  }
  registerFail(ip);
  return res.status(401).json({ ok: false, error: 'Credenciais inválidas.', needTotp: Boolean(config.auth.totpSecret) });
}

function requireAuth(req, res, next) {
  const s = readSession(req);
  if (s) {
    req.session = s;
    return next();
  }
  if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, error: 'Sessão expirada.' });
  return res.redirect('/login');
}

// Proteção CSRF para requisições que alteram estado: SameSite=strict + Origin/Host + cabeçalho custom.
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (origin) {
    try {
      if (new URL(origin).host !== host) return res.status(403).json({ ok: false, error: 'Origem inválida.' });
    } catch {
      return res.status(403).json({ ok: false, error: 'Origem inválida.' });
    }
  }
  if (req.headers['x-requested-with'] !== 'orx') return res.status(403).json({ ok: false, error: 'Requisição inválida.' });
  return next();
}

module.exports = { hashPassword, verifyPassword, verifyTotp, totpAt, login, requireAuth, csrfGuard, clearSession, readSession };
