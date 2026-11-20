'use strict';
// Yahoo Finance (endpoint público de gráficos v8, sem autenticação). Dados com ~15 min de atraso.
const { cached, fetchJson } = require('../lib/net');

const BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';

async function rawChart(symbol, range, interval, prepost = false) {
  const url = `${BASE}${encodeURIComponent(symbol)}?range=${range}&interval=${interval}${prepost ? '&includePrePost=true' : ''}&events=div%2Csplit`;
  const j = await fetchJson(url, { maxConc: 4 });
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r) throw new Error(`Yahoo sem dados para ${symbol}`);
  return r;
}

function toCandles(r) {
  const ts = r.timestamp || [];
  const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open && q.open[i], h = q.high && q.high[i], l = q.low && q.low[i], c = q.close && q.close[i];
    if ([o, h, l, c].some((x) => x == null || !Number.isFinite(x))) continue; // descarta candles incompletos
    out.push({ t: ts[i], o, h, l, c, v: (q.volume && q.volume[i]) || 0 });
  }
  return out;
}

// Histórico diário (2 anos => MMA200 confiável).
function history(symbol, range = '2y', interval = '1d') {
  const ttl = interval === '1d' ? 10 * 60e3 : 2 * 60e3;
  return cached(`yh:${symbol}:${range}:${interval}`, ttl, async () => {
    const r = await rawChart(symbol, range, interval);
    const candles = toCandles(r);
    const divs = r.events && r.events.dividends ? Object.values(r.events.dividends).map((d) => ({ t: d.date, amount: d.amount })) : [];
    return { symbol, meta: slimMeta(r.meta), candles, dividends: divs };
  });
}

function slimMeta(m) {
  return {
    currency: m.currency,
    exchange: m.exchangeName,
    tz: m.exchangeTimezoneName,
    price: m.regularMarketPrice,
    time: m.regularMarketTime,
    dayHigh: m.regularMarketDayHigh,
    dayLow: m.regularMarketDayLow,
    volume: m.regularMarketVolume,
    high52: m.fiftyTwoWeekHigh,
    low52: m.fiftyTwoWeekLow,
    name: m.shortName || m.longName || m.symbol,
    period: m.currentTradingPeriod,
  };
}

// Cotação resumida. A variação é calculada contra o fechamento do pregão ANTERIOR
// (chartPreviousClose do Yahoo é o fechamento antes do início do range, não de ontem).
function quote(symbol) {
  return cached(`yq:${symbol}`, 75e3, async () => {
    const r = await rawChart(symbol, '5d', '1d');
    const m = r.meta;
    const candles = toCandles(r);
    const price = m.regularMarketPrice;
    const off = Number(m.gmtoffset) || 0;
    const day = (t) => new Date((t + off) * 1000).toISOString().slice(0, 10);
    let prev = null, prevT = null;
    if (candles.length >= 1) {
      // Compara DATAS no fuso da bolsa (candles diários de câmbio vêm em 00:00 UTC).
      const last = candles[candles.length - 1];
      const sameDay = day(last.t) === day(m.regularMarketTime);
      const p = sameDay ? candles[candles.length - 2] : last;
      if (p) { prev = p.c; prevT = p.t; }
    }
    let chg = prev ? (price / prev - 1) * 100 : null;
    // ANTI-ERRO: variação implausível ou referência velha => dado suspeito, excluído das análises.
    let suspect = null;
    const limit = /=X$/.test(symbol) ? 8 : /^\^(VIX|VVIX|VXEWZ|VXEEM|MOVE)$/.test(symbol) ? 80 : 20;
    if (chg != null && Math.abs(chg) > limit) suspect = `variação de ${chg.toFixed(1)}% acima do plausível (${limit}%)`;
    if (prevT && m.regularMarketTime - prevT > 6 * 86400) suspect = 'fechamento de referência com mais de 6 dias';
    if (!Number.isFinite(price) || price <= 0) suspect = 'preço inválido';
    if (suspect) chg = null;
    return {
      symbol,
      name: m.shortName || m.longName || symbol,
      price: Number.isFinite(price) && price > 0 ? price : null,
      prev,
      chg,
      suspect,
      time: m.regularMarketTime,
      currency: m.currency,
      spark: candles.map((c) => c.c),
    };
  });
}

// Pré/pós-mercado (ativos dos EUA): último preço fora do pregão regular.
function extended(symbol) {
  return cached(`yx:${symbol}`, 90e3, async () => {
    const r = await rawChart(symbol, '1d', '5m', true);
    const m = r.meta;
    const p = m.currentTradingPeriod || {};
    const candles = toCandles(r);
    const post = p.post ? candles.filter((c) => c.t >= p.post.start && c.t < p.post.end) : [];
    const pre = p.pre ? candles.filter((c) => c.t >= p.pre.start && c.t < p.pre.end) : [];
    const regular = m.regularMarketPrice;
    const pick = (arr) => (arr.length ? arr[arr.length - 1] : null);
    const lp = pick(post), lpr = pick(pre);
    return {
      symbol,
      regular,
      post: lp ? { price: lp.c, time: lp.t, chg: (lp.c / regular - 1) * 100 } : null,
      pre: lpr ? { price: lpr.c, time: lpr.t } : null,
    };
  });
}

module.exports = { history, quote, extended };
