'use strict';
// Grade de opções com 3 fontes, em ordem de preferência:
//  1) OpLab  (B3, pago)              -> OPLAB_TOKEN
//  2) Tradier (EUA, conta dev grátis) -> TRADIER_TOKEN
//  3) Modo TEÓRICO (sem token): grade sintética precificada por Black-Scholes com vol. estimada.
//     Preços teóricos NUNCA são apresentados como cotação real — a camada anti-erro marca e restringe.
// Gregas e VI são SEMPRE recalculadas pelo nosso Black-Scholes para consistência entre fontes.
const { cached, fetchJson } = require('../lib/net');
const { config } = require('../config');
const bs = require('../quant/bs');
const cal = require('./calendar');

const DAY = 86400e3;

function dteOf(isoDate) {
  // Dias corridos até o vencimento (fechamento ~18h BRT). Mínimo 0.
  const exp = Date.parse(isoDate + 'T21:00:00Z');
  return Math.max(0, (exp - Date.now()) / DAY);
}

function strikeStep(S, market) {
  if (market === 'US') return S < 25 ? 0.5 : S < 100 ? 1 : S < 250 ? 2.5 : 5;
  return S < 10 ? 0.25 : S < 25 ? 0.5 : S < 60 ? 1 : S < 150 ? 2 : 5;
}

function enrich(o, S, r, q) {
  const T = o.dte / 365;
  const mid = o.bid > 0 && o.ask > 0 ? (o.bid + o.ask) / 2 : o.last > 0 ? o.last : null;
  const iv = o.ivProvided || (mid ? bs.impliedVol(o.type, mid, S, o.strike, T, r, q) : null);
  const g = iv ? bs.greeks(o.type, S, o.strike, T, r, iv, q) : null;
  return {
    ...o,
    mid,
    iv,
    delta: g ? g.delta : null,
    gamma: g ? g.gamma : null,
    theta: g ? g.theta : null,
    vega: g ? g.vega : null,
    probITM: g ? g.probITM : null,
    spreadPct: o.bid > 0 && o.ask > 0 ? ((o.ask - o.bid) / ((o.ask + o.bid) / 2)) * 100 : null,
  };
}

// ---------------- Tradier (EUA) ----------------
async function tradierChain(ticker, S, r, q) {
  const base = config.providers.tradierEnv === 'production' ? 'https://api.tradier.com' : 'https://sandbox.tradier.com';
  const headers = { Authorization: `Bearer ${config.providers.tradierToken}`, Accept: 'application/json' };
  const exps = await cached(`tr:exp:${ticker}`, 3600e3, async () => {
    const j = await fetchJson(`${base}/v1/markets/options/expirations?symbol=${ticker}`, { headers });
    const d = j && j.expirations && j.expirations.date;
    return Array.isArray(d) ? d : d ? [d] : [];
  });
  const chosen = exps.filter((d) => dteOf(d) >= 5 && dteOf(d) <= 120).slice(0, 8);
  const expirations = [];
  for (const date of chosen) {
    const rows = await cached(`tr:ch:${ticker}:${date}`, 5 * 60e3, async () => {
      const j = await fetchJson(`${base}/v1/markets/options/chains?symbol=${ticker}&expiration=${date}&greeks=true`, { headers });
      const o = j && j.options && j.options.option;
      return Array.isArray(o) ? o : o ? [o] : [];
    });
    const dte = dteOf(date);
    const options = rows.map((x) => enrich({
      symbol: x.symbol,
      type: x.option_type === 'call' ? 'call' : 'put',
      strike: Number(x.strike),
      bid: Number(x.bid) || 0,
      ask: Number(x.ask) || 0,
      last: Number(x.last) || 0,
      volume: Number(x.volume) || 0,
      oi: Number(x.open_interest) || 0,
      dte,
      expiry: date,
      providerIv: x.greeks && x.greeks.mid_iv ? Number(x.greeks.mid_iv) : null,
      providerDelta: x.greeks && x.greeks.delta != null ? Number(x.greeks.delta) : null,
      multiplier: Number(x.contract_size) || 100,
    }, S, r, q));
    expirations.push({ date, dte, options });
  }
  return { source: 'Tradier', real: true, delayed: config.providers.tradierEnv !== 'production', expirations };
}

// ---------------- OpLab (B3) ----------------
// Conector escrito sem acesso à documentação oficial (indisponível no momento do desenvolvimento).
// O mapeamento aceita nomes de campos alternativos e valida tudo; VALIDAR ao configurar o token.
async function oplabChain(ticker, S, r, q) {
  const headers = { 'Access-Token': config.providers.oplabToken, Accept: 'application/json' };
  const rows = await cached(`op:${ticker}`, 60e3, () => fetchJson(`https://api.oplab.com.br/v3/market/options/${ticker}`, { headers }));
  if (!Array.isArray(rows)) throw new Error('OpLab: resposta inesperada (esperada lista de opções)');
  const pick = (o, ...ks) => { for (const k of ks) if (o[k] != null && o[k] !== '') return o[k]; return null; };
  const byExp = new Map();
  for (const x of rows) {
    const cat = String(pick(x, 'category', 'type', 'option_type') || '').toUpperCase();
    const type = cat.startsWith('C') ? 'call' : cat.startsWith('P') ? 'put' : null;
    const strike = Number(pick(x, 'strike', 'strike_price'));
    const due = String(pick(x, 'due_date', 'expiration', 'maturity_date') || '').slice(0, 10);
    if (!type || !(strike > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(due)) continue;
    const dte = dteOf(due);
    if (dte < 1 || dte > 130) continue;
    const o = enrich({
      symbol: String(pick(x, 'symbol', 'ticker')),
      type,
      strike,
      bid: Number(pick(x, 'bid')) || 0,
      ask: Number(pick(x, 'ask')) || 0,
      last: Number(pick(x, 'close', 'last', 'last_price')) || 0,
      volume: Number(pick(x, 'volume', 'financial_volume_qty')) || 0,
      oi: Number(pick(x, 'open_interest', 'oi')) || 0,
      dte,
      expiry: due,
      multiplier: 1, // B3: cotação por opção; lote padrão 100
      style: String(pick(x, 'maturity_type', 'style') || '').toUpperCase().startsWith('A') ? 'americana' : 'europeia',
    }, S, r, q);
    if (!byExp.has(due)) byExp.set(due, []);
    byExp.get(due).push(o);
  }
  const expirations = [...byExp.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(0, 6).map(([date, options]) => ({ date, dte: dteOf(date), options }));
  if (!expirations.length) throw new Error('OpLab: nenhuma série válida retornada');
  return { source: 'OpLab', real: true, delayed: false, unvalidated: true, expirations };
}

// ---------------- Teórico ----------------
function theoreticalChain(ticker, market, S, r, q, volModel) {
  const dates = market === 'US' ? cal.usExpirations(5) : cal.b3Expirations(5);
  const step = strikeStep(S, market);
  const center = Math.round(S / step) * step;
  const expirations = [];
  for (const date of dates) {
    const dte = dteOf(date);
    if (dte < 3 || dte > 130) continue;
    const options = [];
    for (let i = -14; i <= 14; i++) {
      const K = +(center + i * step).toFixed(2);
      if (K <= 0) continue;
      const iv = volModel.ivAt(K, S, dte);
      for (const type of ['call', 'put']) {
        const T = dte / 365;
        const g = bs.greeks(type, S, K, T, r, iv, q);
        const mid = Math.max(0.01, +g.price.toFixed(2));
        const half = Math.max(0.01, mid * 0.03);
        options.push({
          symbol: `${ticker} ${type === 'call' ? 'CALL' : 'PUT'} ${K.toFixed(2)} ${date}`,
          seriesHint: market === 'B3' ? `${ticker.slice(0, 4)}${cal.b3SeriesLetter(type, date)} strike ${K.toFixed(2)}` : null,
          type, strike: K, dte, expiry: date,
          bid: +(mid - half).toFixed(2), ask: +(mid + half).toFixed(2), last: 0, mid,
          volume: null, oi: null, iv, delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega, probITM: g.probITM,
          spreadPct: null, theoretical: true, multiplier: market === 'US' ? 100 : 1,
        });
      }
    }
    expirations.push({ date, dte, options });
  }
  return { source: 'Teórico (Black-Scholes)', real: false, theoretical: true, volMethod: volModel.method, expirations };
}

async function getChain(ticker, market, S, r, q, volModel) {
  const errors = [];
  if (market === 'B3' && config.providers.oplabToken) {
    try { return await oplabChain(ticker, S, r, q); } catch (e) { errors.push(String(e.message)); }
  }
  if (market === 'US' && config.providers.tradierToken) {
    try { return await tradierChain(ticker, S, r, q); } catch (e) { errors.push(String(e.message)); }
  }
  const t = theoreticalChain(ticker, market, S, r, q, volModel);
  t.providerErrors = errors;
  return t;
}

// Fluxo incomum: só com grade real (volume/contratos em aberto de verdade).
function unusualFlow(chain, S, ticker) {
  if (!chain || !chain.real) return [];
  const out = [];
  for (const e of chain.expirations) {
    for (const o of e.options) {
      if (!o.volume || !o.mid) continue;
      const mult = o.multiplier || 1;
      const notional = o.volume * o.mid * mult;
      const volOi = o.oi ? o.volume / o.oi : null;
      const minNotional = mult === 100 ? 250000 : 500000;
      if (notional < minNotional) continue;
      if (volOi != null && volOi < 1.5 && notional < minNotional * 4) continue;
      let side = 'indefinido';
      if (o.last && o.bid && o.ask) side = o.last >= o.ask - (o.ask - o.bid) * 0.2 ? 'agressão compradora' : o.last <= o.bid + (o.ask - o.bid) * 0.2 ? 'agressão vendedora' : 'meio do spread';
      out.push({ ticker, symbol: o.symbol, type: o.type, strike: o.strike, expiry: o.expiry, dte: Math.round(o.dte), volume: o.volume, oi: o.oi, volOi, notional, side, moneyness: ((o.strike / S - 1) * 100), iv: o.iv });
    }
  }
  return out.sort((a, b) => b.notional - a.notional).slice(0, 15);
}

module.exports = { getChain, unusualFlow, dteOf, strikeStep };
