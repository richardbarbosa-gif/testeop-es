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
const macrocal = require('./quant/macrocal');
const strategy = require('./quant/strategy');
const explain = require('./quant/explain');
const { journal, ivHistory } = require('./lib/store');
const { settle, cached } = require('./lib/net');
const { config } = require('./config');
const { UNDERLYINGS, GROUPS, MACRO_GROUPS, ADRS, resolve } = require('./universe');

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
    const core = liveCore(q, true);
    return { at: Date.now(), status: { b3: marketOpen('B3'), ny: marketOpen('US') }, regime: reg, core: { score: core, bucket: core != null ? macrocal.bucketOf(core).label : null }, groups, adrs, brasil: br, news: nw, calendar: cal.upcoming(45) };
  });
}

function dividendYield(hist, price) {
  const cutoff = Date.now() / 1000 - 365 * 86400;
  const sum = (hist.dividends || []).filter((d) => d.t >= cutoff).reduce((a, d) => a + d.amount, 0);
  return price ? clamp(sum / price, 0, 0.15) : 0;
}

// Índice de regime CENTRAL (mesmas regras usadas na calibração histórica).
function liveCore(q, raw = false) {
  const g = (s) => q[s] || null;
  const vix = g('^VIX'), dxy = g('DX-Y.NYB'), brl = g('BRL=X'), tnx = g('^TNX'), spx = g('^GSPC');
  const bps = tnx ? (raw ? (tnx.prev ? (tnx.price - tnx.prev) * 100 : null) : tnx.bps) : null;
  return macrocal.coreScore({ vix: vix && vix.price, vixChg: vix && vix.chg, dxyChg: dxy && dxy.chg, brlChg: brl && brl.chg, tnxBps: bps, spxChg: spx && spx.chg });
}

function regimeHistory() {
  return cached('regime:hist', 12 * 3600e3, async () => {
    const [vix, dxy, brl, tnx, spx] = await Promise.all(['^VIX', 'DX-Y.NYB', 'BRL=X', '^TNX', '^GSPC'].map((s) => yahoo.history(s, '5y', '1d')));
    return { map: macrocal.buildRegimeHistory({ vix, dxy, brl, tnx, spx }) };
  });
}

function dividendYield(hist, price) {
  const cutoff = Date.now() / 1000 - 365 * 86400;
  const sum = (hist.dividends || []).filter((d) => d.t >= cutoff).reduce((a, d) => a + d.amount, 0);
  return price ? clamp(sum / price, 0, 0.15) : 0;
}

function resolveOr400(ticker) {
  const u = resolve(ticker);
  if (!u) throw Object.assign(new Error('Ticker inválido. Use o código da B3 (ex.: PETR4) ou dos EUA (ex.: EWZ).'), { status: 400 });
  return u;
}

// Núcleo do ativo (uso interno: inclui o histórico longo).
async function assetCore(ticker) {
  const u = resolveOr400(ticker);
  let hist, q;
  try {
    [hist, q] = await Promise.all([yahoo.history(u.y, '2y', '1d'), yahoo.quote(u.y)]);
  } catch (e) {
    throw Object.assign(new Error(`Não encontrei dados para ${u.ticker}. Confira o código do ativo.`), { status: 404 });
  }
  if (!hist.candles.length || !q.price) throw Object.assign(new Error(`Sem cotações recentes para ${u.ticker}.`), { status: 404 });
  const [long, mkt] = await Promise.all([
    yahoo.history(u.y, '5y', '1d').catch(() => null),
    yahoo.history(u.market === 'US' ? '^GSPC' : '^BVSP', '2y', '1d').catch(() => null),
  ]);
  const analysis = ta.analyze(hist.candles);
  // Salto de preço: separa crash sistêmico (o índice caiu junto) de salto específico do ativo.
  if (analysis.ok && analysis.jump && mkt) {
    const day = (t, off) => new Date((t + (off || 0)) * 1000).toISOString().slice(0, 10);
    const d = day(analysis.jump.t, hist.meta.gmtoffset);
    const mc = mkt.candles;
    let mret = null;
    for (let i = 1; i < mc.length; i++) if (day(mc[i].t, mkt.meta.gmtoffset) === d) { mret = (mc[i].c / mc[i - 1].c - 1) * 100; break; }
    if (mret != null) {
      const excess = analysis.jump.pct - 2 * mret; // tolera beta até 2
      analysis.jump = { ...analysis.jump, market: mret, excess, systemic: Math.abs(mret) >= 5 && Math.abs(excess) <= 30 };
    }
  }
  const lastT = hist.candles[hist.candles.length - 1].t;
  const calib = long ? await cached(`calib:${u.ticker}:${lastT}`, 12 * 3600e3, async () => ta.calibrate(long.candles)) : { ok: false, reason: 'sem histórico longo' };
  const verdict = analysis.ok ? ta.calibVerdict(calib, analysis.score) : { status: 'unknown', msg: '' };
  const name = u.custom ? hist.meta.name || u.ticker : u.name;
  return { u, hist, q, long, analysis, calib, verdict, name, lastT };
}

async function asset(ticker) {
  const a = await assetCore(ticker);
  return {
    ticker: a.u.ticker,
    name: a.name,
    market: a.u.market,
    group: a.u.groupTitle,
    custom: Boolean(a.u.custom),
    quote: a.q,
    meta: a.hist.meta,
    candles: a.hist.candles.map((c) => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v })),
    ta: a.analysis,
    calib: a.calib,
    audit: a.verdict,
    dividendYield: dividendYield(a.hist, a.q.price),
  };
}

async function lookup(ticker) {
  const u = resolveOr400(ticker);
  try {
    const q = await yahoo.quote(u.y);
    if (!q.price) throw new Error('sem preço');
    return { ticker: u.ticker, name: u.custom ? q.name : u.name, market: u.market, price: q.price, chg: q.chg, custom: Boolean(u.custom) };
  } catch {
    throw Object.assign(new Error(`Ativo ${u.ticker} não encontrado.`), { status: 404 });
  }
}

// Modelo de VI para o modo teórico (sem grade real).
async function volModelFor(ticker, taRes) {
  const [vx, ewzHist] = await Promise.all([yahoo.quote('^VXEWZ').catch(() => null), yahoo.history('EWZ', '2y', '1d').catch(() => null)]);
  const vxewz = vx && vx.price ? vx.price / 100 : null;
  // Referência de vol. realizada = previsão (EWMA convergindo para a média de 1 ano): reage ao
  // regime atual sem ficar refém de um único dia de crash como a média simples de 20 dias.
  const ewzHv = ewzHist ? strategy.physVol(ta.analyze(ewzHist.candles), 40) : null;
  let base, method, real = false;
  if (ticker === 'EWZ' && vxewz) {
    base = vxewz;
    real = true;
    method = `VI real do índice VXEWZ (${(vxewz * 100).toFixed(1)}%)`;
  } else {
    const hvBlend = strategy.physVol(taRes, 40) || 0.6 * (taRes.hv20 || 0.3) + 0.4 * (taRes.hv60 || taRes.hv20 || 0.3);
    const vrp = vxewz && ewzHv ? clamp(vxewz / ewzHv, 0.85, 1.5) : 1.1;
    base = Math.max(0.12, hvBlend * vrp);
    method = `vol. prevista do ativo × prêmio de risco de vol. do Brasil (VXEWZ ÷ vol. prevista do EWZ = ${vrp.toFixed(2)}x)`;
  }
  return {
    base,
    method,
    real,
    ivAt(K, S) {
      const m = Math.log(K / S);
      const skew = m < 0 ? 1 - 0.9 * m : 1 - 0.3 * m; // puts OTM mais caras (skew típico de ações)
      return base * clamp(skew, 0.75, 1.6);
    },
  };
}

const TAGS = { BOVA11: 'IBOV', SMAL11: 'IBOV', EWZ: 'IBOV', PBR: 'PETR4', PETR3: 'PETR4', VALE: 'VALE3', ITUB: 'ITUB4', BRAP4: 'VALE3' };

async function operation(ticker, { capital, riskPct, lite = false } = {}) {
  const [a, m, reg] = await Promise.all([assetCore(ticker), macro(), regimeHistory().catch(() => null)]);
  const u = a.u;
  const T = u.ticker;
  if (!a.analysis.ok) throw Object.assign(new Error(a.analysis.error), { status: 422 });
  const q = {};
  for (const g of m.groups) for (const it of g.items) if (!it.missing) q[it.symbol] = it;
  const S = a.q.price;
  const cdi = m.brasil && m.brasil.cdi ? m.brasil.cdi.value / 100 : 0.14;
  const r = u.market === 'B3' ? Math.log(1 + cdi) : q['^IRX'] ? q['^IRX'].price / 100 : 0.04;
  const qd = dividendYield(a.hist, S);
  const vm = await volModelFor(T, a.analysis);
  const chain = await opt.getChain(T, u.market, S, r, qd, vm);

  // Calibração macro deste ativo
  const mcal = reg && a.long ? await cached(`mcal:${T}:${a.lastT}`, 12 * 3600e3, async () => macrocal.calibrateAsset(reg.map, a.long)) : { ok: false };
  const core = liveCore(q);
  const macroAudit = macrocal.verdict(mcal, core);

  // Antecedentes: ADR no after-market + commodity/câmbio do setor
  let leadScore = 0, adrPost = null;
  const parts = [];
  const adrSym = u.market === 'B3' ? u.adr : T;
  const adr = m.adrs.find((x) => x.symbol === adrSym);
  if (adr && adr.post && Date.now() / 1000 - adr.post.time < 18 * 3600) {
    adrPost = adr.post.chg;
    leadScore += adrPost * 30;
    parts.push(`${adrSym} after ${adrPost >= 0 ? '+' : ''}${adrPost.toFixed(2)}%`);
  }
  for (const f of u.factors) {
    if (q[f] && Number.isFinite(q[f].chg)) {
      leadScore += q[f].chg * 12;
      parts.push(`${f} ${q[f].chg >= 0 ? '+' : ''}${q[f].chg.toFixed(2)}%`);
    }
  }
  const lead = parts.length ? { score: clamp(leadScore, -100, 100), label: `Antecedentes (${parts.join(', ')})`, adrPost } : null;
  const newsTag = m.news.byTag[TAGS[T] || T];

  const firstExp = chain.expirations.length ? chain.expirations[Math.min(2, chain.expirations.length - 1)].date : null;
  const atmIvForHist = (() => {
    const e = chain.expirations.find((x) => x.dte >= 25) || chain.expirations[0];
    if (!e) return null;
    const atm = e.options.filter((o) => o.iv).sort((x, y) => Math.abs(x.strike - S) - Math.abs(y.strike - S)).slice(0, 4);
    return atm.length ? atm.reduce((s2, o) => s2 + o.iv, 0) / atm.length : null;
  })();
  if (chain.real && atmIvForHist) ivHistory.record(T, atmIvForHist);
  const ivh = chain.real ? ivHistory.stats(T, atmIvForHist) : null;

  const ctx = {
    ticker: T, market: u.market, S, r, q: qd, ta: a.analysis, regime: m.regime, lead, newsTag, ivHistory: ivh,
    techAudit: a.verdict, techCalib: a.calib, macroAudit, macroCalib: mcal, calibHorizon: 10,
    ivReal: Boolean(chain.real || vm.real), ivFallback: vm.base, vix: q['^VIX'] ? q['^VIX'].price : null,
    strikeStep: opt.strikeStep(S, u.market),
    capital: Number(capital) > 0 ? Number(capital) : config.risk.capital,
    maxRiskPct: Number(riskPct) > 0 ? clamp(Number(riskPct), 0.25, 10) : config.risk.maxRiskPct,
    usdbrl: q['BRL=X'] ? q['BRL=X'].price : 5.5,
    marketOpen: marketOpen(u.market),
    priceAgeMin: a.q.time ? (Date.now() / 1000 - a.q.time) / 60 : null,
    historyLen: a.hist.candles.length,
    eventsAll: m.calendar,
    events: firstExp ? cal.eventsUntil(firstExp) : [],
  };
  const res = strategy.generate(ctx, chain);
  if (res.best) ctx.events = cal.eventsUntil(res.best.legs.reduce((mx, l) => (l.expiry > mx ? l.expiry : mx), ''));
  const why = explain.rationale(res, ctx);
  const steps = explain.execution(res.best, ctx, res.decision);
  const flow = opt.unusualFlow(chain, S, T);

  const num = (x) => (Number.isFinite(x) ? x : null);
  const slim = (c) => c && {
    key: c.key, intent: c.intent, name: c.name, family: c.family, score: c.score, horizon: c.horizon,
    cost: c.cost, debit: c.debit, maxProfit: num(c.maxProfit), maxLoss: num(c.maxLoss), unlimitedGain: c.unlimitedGain, unlimitedLoss: c.unlimitedLoss,
    breakevens: c.breakevens, pop: c.pop, popPhys: c.popPhys, evPhys: c.evPhys, ror: num(c.ror), var5: num(c.var5), rr: num(c.rr), greeks: c.greeks,
    lots: c.lots, lotsFull: c.lotsFull != null ? c.lotsFull : c.lots, sizeFactor: c.sizeFactor || 1, lot: c.lot, fx: c.fx, riskPerLot: num(c.riskPerLot),
    expMove: c.expMove, beMove: c.beMove, payoff: c.payoff, scoreWhy: c.scoreWhy, guard: c.guard,
    legs: c.legs.map((l) => ({ symbol: l.symbol, seriesHint: l.seriesHint || null, type: l.type, side: l.side, strike: l.strike, expiry: l.expiry, dte: Math.round(l.dte), bid: l.bid, ask: l.ask, mid: l.mid, iv: l.iv, delta: l.delta, gamma: l.gamma, theta: l.theta, vega: l.vega, volume: l.volume, oi: l.oi, spreadPct: l.spreadPct, theoretical: Boolean(l.theoretical) })),
  };
  const payload = {
    ticker: T, name: a.name, group: u.groupTitle, market: u.market, S, chg: a.q.chg,
    decision: res.decision, notWorth: res.notWorth, plain: res.plain, triggers: res.triggers,
    dir: res.dir, vol: res.vol, regime: { score: m.regime.score, label: m.regime.label, stress: m.regime.stress, core },
    techScore: a.analysis.score, trend: a.analysis.trend,
    best: slim(res.best), alternatives: res.alternatives.map(slim), rejected: res.rejected.map(slim),
    contextChecks: res.contextChecks, rationale: why, execution: steps, flow,
    chain: { source: chain.source, real: chain.real, volMethod: chain.volMethod || null, providerErrors: chain.providerErrors || [] },
    inputs: { r, q: qd, capital: ctx.capital, maxRiskPct: ctx.maxRiskPct, events: ctx.events },
    at: Date.now(),
  };
  // Não serializar objetos internos pesados
  payload.dir = { ...res.dir, techAudit: res.dir.techAudit && { status: res.dir.techAudit.status, msg: res.dir.techAudit.msg, short: res.dir.techAudit.short }, macroAudit: res.dir.macroAudit && { status: res.dir.macroAudit.status, msg: res.dir.macroAudit.msg, short: res.dir.macroAudit.short } };
  if (!lite) {
    payload.ai = await explain.aiNarrative({
      ativo: T, preco: S, decisao: res.decision, porque_nao: res.notWorth, leitura: res.plain, gatilhos: res.triggers,
      direcional: payload.dir, volatilidade: res.vol, tecnico: a.analysis.diagnosis,
      operacao: slim(res.best) && { ...slim(res.best), payoff: undefined, guard: undefined },
    });
  }
  return payload;
}

// ---------------- Scanner (todos os ativos) ----------------
const scan = { running: false, startedAt: null, finishedAt: null, done: 0, total: 0, rows: [], partial: [] };
const LEVEL_ORDER = { operar: 0, reduzido: 1, nao_vale: 2, bloqueado: 3 };

function summaryRow(o) {
  const b = o.best;
  return {
    ticker: o.ticker, name: o.name, group: o.group, market: o.market, price: o.S, chg: o.chg,
    techScore: o.techScore, trend: o.trend, techStatus: o.dir.techAudit && o.dir.techAudit.status, macroStatus: o.dir.macroAudit && o.dir.macroAudit.status,
    bias: o.dir.bias, biasLabel: o.dir.label, confidence: o.dir.confidence, volLabel: o.vol.label, ivRatio: o.vol.ratio,
    level: o.decision.level, label: o.decision.label, strategy: b ? b.name : null, intent: b ? b.intent : null, score: b ? b.score : null,
    ror: b ? b.ror : null, evLot: b ? b.evPhys * b.lot * b.fx : null, popPhys: b ? b.popPhys : null,
  };
}

async function runScan() {
  if (scan.running) return;
  scan.running = true;
  scan.startedAt = Date.now();
  const tickers = Object.keys(UNDERLYINGS);
  scan.total = tickers.length;
  scan.done = 0;
  scan.partial = [];
  for (const t of tickers) {
    try {
      scan.partial.push(summaryRow(await operation(t, { lite: true })));
    } catch (e) {
      scan.partial.push({ ticker: t, name: UNDERLYINGS[t].name, group: UNDERLYINGS[t].groupTitle, error: e.message });
    }
    scan.done++;
    await new Promise((r) => setTimeout(r, 30)); // cede a vez às requisições do usuário
  }
  const sortRows = (rows) => rows.sort((x, y) => (x.error ? 9 : LEVEL_ORDER[x.level]) - (y.error ? 9 : LEVEL_ORDER[y.level]) || (y.score || 0) - (x.score || 0));
  scan.rows = sortRows(scan.partial.slice());
  scan.finishedAt = Date.now();
  scan.running = false;
}

function scanState() {
  const rows = scan.rows.length ? scan.rows : scan.partial;
  return { running: scan.running, done: scan.done, total: scan.total, startedAt: scan.startedAt, finishedAt: scan.finishedAt, rows };
}

function startScanner() {
  const tick = () => runScan().catch((e) => { scan.running = false; console.error('[scanner]', e.message); });
  setTimeout(tick, 8000).unref();
  setInterval(tick, 15 * 60e3).unref();
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
      const avg = c.slice(-21, -1).reduce((s2, x) => s2 + x.v, 0) / 20;
      const chg = (last.c / c[c.length - 2].c - 1) * 100;
      const ratio = avg ? last.v / avg : null;
      rows.push({ ticker: t, market: UNDERLYINGS[t].market, ratio, chg, close: last.c, volume: last.v, avgVolume: avg, flag: ratio > 1.8 ? (chg >= 0 ? 'compra forte' : 'venda forte') : ratio > 1.3 ? 'acima da média' : null });
    });
    rows.sort((a, b) => (b.ratio || 0) - (a.ratio || 0));
    const optionsFlow = [];
    const providers = { b3: Boolean(config.providers.oplabToken), us: Boolean(config.providers.tradierToken) };
    if (providers.us || providers.b3) {
      const targets = [providers.us && 'EWZ', providers.us && 'PBR', providers.us && 'VALE', providers.b3 && 'PETR4', providers.b3 && 'VALE3', providers.b3 && 'BOVA11'].filter(Boolean);
      const flows = await settle(targets.map((t) => async () => {
        const u = UNDERLYINGS[t];
        const qq = await yahoo.quote(u.y);
        const chain = await opt.getChain(t, u.market, qq.price, 0.1, 0, { base: 0.3, ivAt: () => 0.3, method: '' });
        return opt.unusualFlow(chain, qq.price, t);
      }));
      for (const f of flows) if (f.ok) optionsFlow.push(...f.value);
      optionsFlow.sort((a, b) => b.notional - a.notional);
    }
    return { at: Date.now(), volume: rows.slice(0, 20), options: optionsFlow.slice(0, 25), providers };
  });
}

// Diário: marcação a mercado (teórica quando não há grade real) e liquidação no vencimento.
async function journalView() {
  const entries = journal.list();
  const out = [];
  for (const e of entries) {
    const u = resolve(e.ticker);
    let mtm = null, note = '';
    try {
      if (u && e.status === 'aberta') {
        const hist = await yahoo.history(u.y, '2y', '1d');
        const lastExp = e.legs.reduce((mx, l) => (l.expiry > mx ? l.expiry : mx), '');
        const today = new Date().toISOString().slice(0, 10);
        // Marcação com os MESMOS parâmetros da entrada (VI por perna, juros, dividendos).
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
        const value = e.legs.reduce((acc, l) => {
          const T = Math.max(0, (Date.parse(l.expiry + 'T21:00:00Z') - Date.now()) / 86400e3) / 365;
          const v = T <= 0 ? Math.max(0, l.type === 'call' ? S - l.strike : l.strike - S) : bs.price(l.type, S, l.strike, T, rr, l.iv || sigmaFallback, qq);
          return acc + l.side * v;
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
      pnlClosed: closed.reduce((acc, x) => acc + pnlOf(x), 0),
      pnlOpen: out.filter((x) => x.status === 'aberta' && x.mtm && !x.mtm.expired).reduce((acc, x) => acc + x.mtm.pnl, 0),
    },
  };
}

module.exports = { macro, asset, lookup, operation, flowRadar, journalView, journal, UNDERLYINGS, GROUPS, resolve, scanState, runScan, startScanner };
