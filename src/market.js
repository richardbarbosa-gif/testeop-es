'use strict';
// Orquestração: macro, ativo, geração de operação, fluxo e diário.
const yahoo = require('./sources/yahoo');
const bcb = require('./sources/bcb');
const news = require('./sources/news');
const cal = require('./sources/calendar');
const opt = require('./sources/options');
const ta = require('./quant/ta');
const bs = require('./quant/bs');
const { regime } = require('./quant/regime');
const strategy = require('./quant/strategy');
const explain = require('./quant/explain');
const { journal, ivHistory } = require('./lib/store');
const { settle, cached } = require('./lib/net');
const { config } = require('./config');
const { UNDERLYINGS, MACRO_GROUPS, ADRS } = require('./universe');

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

async function quotesMap(symbols) {
  const uniq = [...new Set(symbols)];
  const res = await settle(uniq.map((s) => () => yahoo.quote(s)));
  const map = {};
  uniq.forEach((s, i) => { if (res[i].ok) map[s] = res[i].value; });
  return map;
}

async function extendedMap() {
  const res = await settle(ADRS.map((s) => () => yahoo.extended(s)));
  const map = {};
  ADRS.forEach((s, i) => { if (res[i].ok) map[s] = res[i].value; });
  return map;
}

function marketOpen(market, now = new Date()) {
  const d = now.getUTCDay();
  if (d === 0 || d === 6) return false;
  if (market === 'B3' && cal.isB3Holiday(now)) return false;
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (market === 'B3') return mins >= 13 * 60 && mins <= 20 * 60 + 55; // 10:00–17:55 BRT (UTC-3)
  // NYSE 9:30–16:00 ET; aproximação cobrindo horário de verão/inverno
  return mins >= 13 * 60 + 30 && mins <= 21 * 60;
}

async function macro() {
  return cached('macro:all', 60e3, async () => {
    const symbols = MACRO_GROUPS.flatMap((g) => g.items.map((i) => i[0]));
    const [q, ext, br, nw] = await Promise.all([
      quotesMap(symbols.concat(ADRS)),
      extendedMap(),
      bcb.snapshot().catch(() => null),
      news.latest().catch(() => ({ items: [], sentiment: 0, byTag: {}, sourcesOk: 0, sourcesTotal: 0 })),
    ]);
    const reg = regime(q, ext, nw);
    const groups = MACRO_GROUPS.map((g) => ({
      id: g.id,
      title: g.title,
      yields: Boolean(g.yields),
      items: g.items.map(([s, label]) => {
        const x = q[s];
        if (!x) return { symbol: s, label, missing: true };
        const out = { symbol: s, label, price: x.price, chg: x.chg, suspect: x.suspect, time: x.time, spark: x.spark };
        if (g.yields && x.prev) out.bps = (x.price - x.prev) * 100;
        return out;
      }),
    }));
    const adrs = ADRS.map((s) => ({ symbol: s, ...(ext[s] || {}), chg: q[s] ? q[s].chg : null }));
    return { at: Date.now(), status: { b3: marketOpen('B3'), ny: marketOpen('US') }, regime: reg, groups, adrs, brasil: br, news: nw, calendar: cal.upcoming(45) };
  });
}

function dividendYield(hist, price) {
  const cutoff = Date.now() / 1000 - 365 * 86400;
  const sum = (hist.dividends || []).filter((d) => d.t >= cutoff).reduce((a, d) => a + d.amount, 0);
  return price ? clamp(sum / price, 0, 0.15) : 0;
}

async function asset(ticker) {
  const u = UNDERLYINGS[ticker];
  if (!u) throw Object.assign(new Error('Ativo não suportado'), { status: 400 });
  const [hist, q, long] = await Promise.all([yahoo.history(u.y, '2y', '1d'), yahoo.quote(u.y), yahoo.history(u.y, '5y', '1d').catch(() => null)]);
  const analysis = ta.analyze(hist.candles);
  // Auditoria do sinal técnico em 5 anos (cache por ativo e por último pregão).
  const lastT = hist.candles.length ? hist.candles[hist.candles.length - 1].t : 0;
  const calib = long ? await cached(`calib:${ticker}:${lastT}`, 12 * 3600e3, async () => ta.calibrate(long.candles)) : { ok: false, reason: 'sem histórico longo' };
  const verdict = analysis.ok ? ta.calibVerdict(calib, analysis.score) : { status: 'unknown', msg: '' };
  return {
    ticker,
    name: u.name,
    market: u.market,
    quote: q,
    meta: hist.meta,
    candles: hist.candles.map((c) => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v })),
    ta: analysis,
    calib,
    audit: verdict,
    dividendYield: dividendYield(hist, q.price),
  };
}

// Modelo de VI para o modo teórico (sem grade real).
async function volModelFor(ticker, u, taRes) {
  const [vx, ewzHist] = await Promise.all([yahoo.quote('^VXEWZ').catch(() => null), yahoo.history('EWZ', '2y', '1d').catch(() => null)]);
  const vxewz = vx && vx.price ? vx.price / 100 : null;
  const ewzHv = ewzHist ? ta.analyze(ewzHist.candles).hv20 : null;
  let base, method;
  if (ticker === 'EWZ' && vxewz) {
    base = vxewz;
    method = `VI real do índice VXEWZ (${(vxewz * 100).toFixed(1)}%)`;
  } else {
    const hvBlend = 0.6 * (taRes.hv20 || 0.3) + 0.4 * (taRes.hv60 || taRes.hv20 || 0.3);
    const vrp = vxewz && ewzHv ? clamp(vxewz / ewzHv, 0.85, 1.5) : 1.1;
    base = Math.max(0.12, hvBlend * vrp);
    method = `vol. histórica do ativo × prêmio de risco de vol. do Brasil (VXEWZ/VH EWZ = ${vrp.toFixed(2)}x)`;
  }
  return {
    base,
    method,
    ivAt(K, S) {
      const m = Math.log(K / S);
      const skew = m < 0 ? 1 - 0.9 * m : 1 - 0.3 * m; // puts OTM mais caras (skew típico de ações)
      return base * clamp(skew, 0.75, 1.6);
    },
  };
}

async function operation(ticker, { capital, riskPct } = {}) {
  const u = UNDERLYINGS[ticker];
  if (!u) throw Object.assign(new Error('Ativo não suportado'), { status: 400 });
  const [a, m] = await Promise.all([asset(ticker), macro()]);
  if (!a.ta.ok) throw Object.assign(new Error(a.ta.error), { status: 422 });
  const q = {};
  for (const g of m.groups) for (const it of g.items) if (!it.missing) q[it.symbol] = it;
  const S = a.quote.price;
  const cdi = m.brasil && m.brasil.cdi ? m.brasil.cdi.value / 100 : 0.14;
  const r = u.market === 'B3' ? Math.log(1 + cdi) : q['^IRX'] ? q['^IRX'].price / 100 : 0.04;
  const qd = a.dividendYield;
  const vm = await volModelFor(ticker, u, a.ta);
  const chain = await opt.getChain(ticker, u.market, S, r, qd, vm);

  // Lead: ADR no after-market + commodity do setor
  let leadScore = 0, parts = [];
  let adrPost = null;
  const adrSym = u.market === 'B3' ? u.adr : ticker;
  const adr = m.adrs.find((x) => x.symbol === adrSym);
  if (adr && adr.post && Date.now() / 1000 - adr.post.time < 18 * 3600) {
    adrPost = adr.post.chg;
    leadScore += adrPost * 30;
    parts.push(`${adrSym} after ${adrPost >= 0 ? '+' : ''}${adrPost.toFixed(2)}%`);
  }
  for (const f of u.factors) {
    if (q[f] && Number.isFinite(q[f].chg)) {
      leadScore += (f === 'BRL=X' ? 1 : 1) * q[f].chg * 12;
      parts.push(`${f} ${q[f].chg >= 0 ? '+' : ''}${q[f].chg.toFixed(2)}%`);
    }
  }
  const lead = parts.length ? { score: clamp(leadScore, -100, 100), label: `Antecedentes (${parts.join(', ')})`, adrPost } : null;
  const tagKey = ticker === 'BOVA11' || ticker === 'EWZ' ? 'IBOV' : ticker === 'PBR' ? 'PETR4' : ticker === 'VALE' ? 'VALE3' : ticker;
  const newsTag = m.news.byTag[tagKey];

  const firstExp = chain.expirations.length ? chain.expirations[Math.min(2, chain.expirations.length - 1)].date : null;
  const atmIvForHist = (() => {
    const e = chain.expirations.find((x) => x.dte >= 25) || chain.expirations[0];
    if (!e) return null;
    const atm = e.options.filter((o) => o.iv).sort((x, y) => Math.abs(x.strike - S) - Math.abs(y.strike - S)).slice(0, 4);
    return atm.length ? atm.reduce((s, o) => s + o.iv, 0) / atm.length : null;
  })();
  if (chain.real && atmIvForHist) ivHistory.record(ticker, atmIvForHist);
  const ivh = chain.real ? ivHistory.stats(ticker, atmIvForHist) : null;

  const ctx = {
    ticker,
    market: u.market,
    S,
    r,
    q: qd,
    ta: a.ta,
    regime: m.regime,
    lead,
    newsTag,
    ivHistory: ivh,
    calib: a.audit,
    calibHorizon: a.calib && a.calib.horizon,
    ivFallback: vm.base,
    strikeStep: opt.strikeStep(S, u.market),
    capital: Number(capital) > 0 ? Number(capital) : config.risk.capital,
    maxRiskPct: Number(riskPct) > 0 ? clamp(Number(riskPct), 0.25, 10) : config.risk.maxRiskPct,
    usdbrl: q['BRL=X'] ? q['BRL=X'].price : 5.5,
    marketOpen: marketOpen(u.market),
    priceAgeMin: a.quote.time ? (Date.now() / 1000 - a.quote.time) / 60 : null,
    historyLen: a.candles.length,
    eventsAll: m.calendar,
    events: firstExp ? cal.eventsUntil(firstExp) : [],
  };
  const res = strategy.generate(ctx, chain);
  if (res.best) ctx.events = cal.eventsUntil(res.best.legs.reduce((mx, l) => (l.expiry > mx ? l.expiry : mx), ''));
  const why = explain.rationale(res, ctx);
  const steps = explain.execution(res.best, ctx);
  const flow = opt.unusualFlow(chain, S, ticker);

  const slim = (c) => c && {
    key: c.key, name: c.name, family: c.family, score: c.score, horizon: c.horizon,
    cost: c.cost, debit: c.debit, maxProfit: c.maxProfit, maxLoss: c.maxLoss, breakevens: c.breakevens,
    pop: c.pop, popSys: c.popSys, evSys: c.evSys, rr: c.rr, greeks: c.greeks, lots: c.lots, lot: c.lot, riskPerLot: c.riskPerLot,
    expMove: c.expMove, beMove: c.beMove, payoff: c.payoff, scoreWhy: c.scoreWhy, guard: c.guard,
    legs: c.legs.map((l) => ({ symbol: l.symbol, seriesHint: l.seriesHint || null, type: l.type, side: l.side, strike: l.strike, expiry: l.expiry, dte: Math.round(l.dte), bid: l.bid, ask: l.ask, mid: l.mid, iv: l.iv, delta: l.delta, gamma: l.gamma, theta: l.theta, vega: l.vega, volume: l.volume, oi: l.oi, spreadPct: l.spreadPct, theoretical: Boolean(l.theoretical) })),
  };
  const payload = {
    ticker, market: u.market, S, decision: res.decision, reasons: res.reasons,
    dir: res.dir, vol: res.vol, regime: { score: m.regime.score, label: m.regime.label, stress: m.regime.stress },
    best: slim(res.best), alternatives: res.alternatives.map(slim), rejected: res.rejected.map(slim),
    contextChecks: res.contextChecks, rationale: why, execution: steps, flow,
    chain: { source: chain.source, real: chain.real, volMethod: chain.volMethod || null, providerErrors: chain.providerErrors || [] },
    inputs: { r, q: qd, capital: ctx.capital, maxRiskPct: ctx.maxRiskPct, events: ctx.events },
    at: Date.now(),
  };
  payload.ai = await explain.aiNarrative({
    ativo: ticker, preco: S, decisao: res.decision, motivos: res.reasons, direcional: res.dir, volatilidade: res.vol,
    regime: m.regime, tecnico: a.ta.diagnosis, operacao: slim(res.best) && { ...slim(res.best), payoff: undefined },
    bloqueios: res.rejected.map((x) => ({ nome: x.name, motivo: x.guard.blocks })), alertas: res.contextChecks.filter((c) => c.status !== 'ok'),
  });
  return payload;
}

// Radar de fluxo: anomalias de volume no ativo-objeto (sempre) + fluxo de opções (com grade real).
async function flowRadar() {
  return cached('flow:radar', 3 * 60e3, async () => {
    const tickers = Object.keys(UNDERLYINGS);
    const res = await settle(tickers.map((t) => () => yahoo.history(UNDERLYINGS[t].y, '2y', '1d')));
    const rows = [];
    tickers.forEach((t, i) => {
      if (!res[i].ok) return;
      const c = res[i].value.candles;
      if (c.length < 30) return;
      const last = c[c.length - 1];
      const avg = c.slice(-21, -1).reduce((s, x) => s + x.v, 0) / 20;
      const chg = (last.c / c[c.length - 2].c - 1) * 100;
      const range = ((last.h - last.l) / c[c.length - 2].c) * 100;
      const ratio = avg ? last.v / avg : null;
      rows.push({ ticker: t, market: UNDERLYINGS[t].market, ratio, chg, range, close: last.c, volume: last.v, avgVolume: avg, flag: ratio > 1.8 ? (chg >= 0 ? 'compra forte' : 'venda forte') : ratio > 1.3 ? 'acima da média' : null });
    });
    rows.sort((a, b) => (b.ratio || 0) - (a.ratio || 0));
    const optionsFlow = [];
    const providers = { b3: Boolean(config.providers.oplabToken), us: Boolean(config.providers.tradierToken) };
    if (providers.us || providers.b3) {
      const targets = [providers.us && 'EWZ', providers.us && 'PBR', providers.us && 'VALE', providers.b3 && 'PETR4', providers.b3 && 'VALE3', providers.b3 && 'BOVA11'].filter(Boolean);
      const flows = await settle(targets.map((t) => async () => {
        const u = UNDERLYINGS[t];
        const q = await yahoo.quote(u.y);
        const chain = await opt.getChain(t, u.market, q.price, 0.1, 0, { base: 0.3, ivAt: () => 0.3, method: '' });
        return opt.unusualFlow(chain, q.price, t);
      }));
      for (const f of flows) if (f.ok) optionsFlow.push(...f.value);
      optionsFlow.sort((a, b) => b.notional - a.notional);
    }
    return { at: Date.now(), volume: rows, options: optionsFlow.slice(0, 25), providers };
  });
}

// Diário: marcação a mercado (teórica quando não há grade real) e liquidação no vencimento.
async function journalView() {
  const entries = journal.list();
  const out = [];
  for (const e of entries) {
    const u = UNDERLYINGS[e.ticker];
    let mtm = null, note = '';
    try {
      if (u && e.status === 'aberta') {
        const hist = await yahoo.history(u.y, '2y', '1d');
        const lastExp = e.legs.reduce((mx, l) => (l.expiry > mx ? l.expiry : mx), '');
        const today = new Date().toISOString().slice(0, 10);
        // Marcação com os MESMOS parâmetros da entrada (VI por perna, juros, dividendos):
        // o resultado reflete só preço e tempo — nunca diferença de modelo.
        const taRes = ta.analyze(hist.candles);
        const sigmaFallback = Math.max(0.12, (taRes.hv20 || 0.3) * 1.1);
        const rr = Number.isFinite(e.r) ? e.r : 0.12;
        const qq = Number.isFinite(e.q) ? e.q : 0;
        let S = hist.candles[hist.candles.length - 1].c;
        let expired = false;
        if (lastExp && lastExp < today) {
          const expTs = Date.parse(lastExp + 'T23:59:59Z') / 1000;
          const c = [...hist.candles].reverse().find((x) => x.t <= expTs);
          if (c) S = c.c;
          expired = true;
        }
        const value = e.legs.reduce((a, l) => {
          const T = Math.max(0, (Date.parse(l.expiry + 'T21:00:00Z') - Date.now()) / 86400e3) / 365;
          const v = T <= 0 ? Math.max(0, l.type === 'call' ? S - l.strike : l.strike - S) : bs.price(l.type, S, l.strike, T, rr, l.iv || sigmaFallback, qq);
          return a + l.side * v;
        }, 0);
        const pnlPerUnit = value - e.cost;
        mtm = { S, value, pnl: pnlPerUnit * (e.lot || 100) * (e.lots || 1), pnlPct: e.cost ? (pnlPerUnit / Math.abs(e.cost)) * 100 : null, expired };
        note = expired ? 'liquidada pelo fechamento do vencimento' : 'marcação teórica com a VI da entrada';
      }
    } catch (err) {
      note = 'sem dados para marcação';
    }
    out.push({ ...e, mtm, note });
  }
  const closed = out.filter((x) => x.status === 'encerrada' || (x.mtm && x.mtm.expired));
  const pnlOf = (x) => (x.status === 'encerrada' ? x.finalPnl : x.mtm && x.mtm.pnl) || 0;
  const wins = closed.filter((x) => pnlOf(x) > 0).length;
  return {
    entries: out,
    stats: {
      total: out.length,
      closed: closed.length,
      winRate: closed.length ? (wins / closed.length) * 100 : null,
      pnlClosed: closed.reduce((a, x) => a + pnlOf(x), 0),
      pnlOpen: out.filter((x) => x.status === 'aberta' && x.mtm && !x.mtm.expired).reduce((a, x) => a + x.mtm.pnl, 0),
    },
  };
}

module.exports = { macro, asset, operation, flowRadar, journalView, journal, UNDERLYINGS };
