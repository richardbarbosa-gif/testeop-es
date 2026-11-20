'use strict';
// HTTP com timeout, cache em memória com TTL, deduplicação de requisições
// simultâneas e limitador de concorrência por host (evita 429 das fontes).
const UA = 'Mozilla/5.0 (compatible; OpcoesRadar/1.0; uso pessoal)';

const cache = new Map(); // key -> { exp, value, at }
const inflight = new Map();

async function cached(key, ttlMs, fn, { staleOkMs = 6 * 3600e3 } = {}) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const value = await fn();
      cache.set(key, { exp: Date.now() + ttlMs, value, at: Date.now() });
      return value;
    } catch (err) {
      // Anti-erro: se a fonte falhar, devolve o último valor bom marcado como "stale",
      // nunca um número inventado. Os consumidores verificam __stale.
      if (hit && Date.now() - hit.at < staleOkMs) {
        const v = hit.value;
        if (v && typeof v === 'object') return Object.assign(Array.isArray(v) ? [...v] : { ...v }, { __stale: true, __staleAt: hit.at });
        return v;
      }
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

const hostSlots = new Map();
async function withHostLimit(host, max, fn) {
  let s = hostSlots.get(host);
  if (!s) hostSlots.set(host, (s = { active: 0, queue: [] }));
  if (s.active >= max) await new Promise((r) => s.queue.push(r));
  s.active++;
  try {
    return await fn();
  } finally {
    s.active--;
    const next = s.queue.shift();
    if (next) next();
  }
}

async function fetchRaw(url, { timeout = 12000, headers = {}, method = 'GET', body, maxConc = 4 } = {}) {
  const host = new URL(url).host;
  return withHostLimit(host, maxConc, async () => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(url, { method, body, headers: { 'User-Agent': UA, Accept: '*/*', ...headers }, signal: ctl.signal, redirect: 'follow' });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} em ${host}`);
        err.status = res.status;
        throw err;
      }
      return res;
    } finally {
      clearTimeout(t);
    }
  });
}

async function fetchJson(url, opts) {
  const res = await fetchRaw(url, opts);
  return res.json();
}

async function fetchText(url, opts) {
  const res = await fetchRaw(url, opts);
  return res.text();
}

// Executa tarefas tolerando falhas individuais: retorna { ok, value | error } por item.
async function settle(tasks) {
  const r = await Promise.allSettled(tasks.map((t) => (typeof t === 'function' ? t() : t)));
  return r.map((x) => (x.status === 'fulfilled' ? { ok: true, value: x.value } : { ok: false, error: String(x.reason && x.reason.message || x.reason) }));
}

module.exports = { cached, fetchJson, fetchText, fetchRaw, settle };
