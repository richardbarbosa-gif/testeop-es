'use strict';
// Análise técnica: MME8, MME20, MMA200, IFR14, ATR14, vol. histórica, suportes/resistências
// por pivôs (fractais) com agrupamento, estrutura de topos/fundos e diagnóstico em texto.

function sma(arr, n) {
  const out = new Array(arr.length).fill(null);
  let s = 0;
  for (let i = 0; i < arr.length; i++) {
    s += arr[i];
    if (i >= n) s -= arr[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

function ema(arr, n) {
  const out = new Array(arr.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null;
  for (let i = 0; i < arr.length; i++) {
    if (i === n - 1) {
      prev = arr.slice(0, n).reduce((a, b) => a + b, 0) / n;
      out[i] = prev;
    } else if (i >= n) {
      prev = arr[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

function rsi(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) {
      g += up; l += dn;
      if (i === n) { g /= n; l /= n; out[i] = 100 - 100 / (1 + g / (l || 1e-12)); }
    } else {
      g = (g * (n - 1) + up) / n;
      l = (l * (n - 1) + dn) / n;
      out[i] = 100 - 100 / (1 + g / (l || 1e-12));
    }
  }
  return out;
}

function atr(c, n = 14) {
  const tr = c.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))));
  const out = new Array(c.length).fill(null);
  let prev = null;
  for (let i = 0; i < tr.length; i++) {
    if (i === n - 1) prev = tr.slice(0, n).reduce((a, b) => a + b, 0) / n;
    else if (i >= n) prev = (prev * (n - 1) + tr[i]) / n;
    out[i] = prev;
  }
  return out;
}

// Volatilidade histórica anualizada (log-retornos), janela n.
function histVol(closes, n = 20, periods = 252) {
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const out = new Array(closes.length).fill(null);
  for (let i = n; i <= rets.length; i++) {
    const w = rets.slice(i - n, i);
    const m = w.reduce((a, b) => a + b, 0) / n;
    const v = w.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1);
    out[i] = Math.sqrt(v * periods);
  }
  return out;
}

function percentileRank(series, value) {
  const xs = series.filter((x) => x != null);
  if (!xs.length) return null;
  return (xs.filter((x) => x <= value).length / xs.length) * 100;
}

// Pivôs fractais (k barras de cada lado) + agrupamento por proximidade (tolerância em % ou ATR).
function levels(c, { k = 3, lookback = 180, tolPct = 1.2 } = {}) {
  const start = Math.max(k, c.length - lookback);
  const raw = [];
  for (let i = start; i < c.length - k; i++) {
    let hi = true, lo = true;
    for (let j = 1; j <= k; j++) {
      if (c[i].h <= c[i - j].h || c[i].h < c[i + j].h) hi = false;
      if (c[i].l >= c[i - j].l || c[i].l > c[i + j].l) lo = false;
    }
    if (hi) raw.push({ price: c[i].h, t: c[i].t, kind: 'top' });
    if (lo) raw.push({ price: c[i].l, t: c[i].t, kind: 'bottom' });
  }
  raw.sort((a, b) => a.price - b.price);
  const clusters = [];
  for (const p of raw) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(p.price / last.avg - 1) * 100 <= tolPct) {
      last.points.push(p);
      last.avg = last.points.reduce((a, b) => a + b.price, 0) / last.points.length;
      last.lastT = Math.max(last.lastT, p.t);
    } else clusters.push({ points: [p], avg: p.price, lastT: p.t });
  }
  return clusters.map((cl) => ({ price: cl.avg, touches: cl.points.length, lastT: cl.lastT }));
}

function structure(c, k = 3, lookback = 120) {
  // Sequência dos últimos topos e fundos (fractais) -> topos/fundos ascendentes ou descendentes.
  const start = Math.max(k, c.length - lookback);
  const tops = [], bottoms = [];
  for (let i = start; i < c.length - k; i++) {
    let hi = true, lo = true;
    for (let j = 1; j <= k; j++) {
      if (c[i].h <= c[i - j].h || c[i].h < c[i + j].h) hi = false;
      if (c[i].l >= c[i - j].l || c[i].l > c[i + j].l) lo = false;
    }
    if (hi) tops.push(c[i].h);
    if (lo) bottoms.push(c[i].l);
  }
  const t2 = tops.slice(-2), b2 = bottoms.slice(-2);
  const hh = t2.length === 2 ? t2[1] > t2[0] : null;
  const hl = b2.length === 2 ? b2[1] > b2[0] : null;
  let label = 'indefinida';
  if (hh && hl) label = 'topos e fundos ascendentes (tendência de alta)';
  else if (hh === false && hl === false) label = 'topos e fundos descendentes (tendência de baixa)';
  else if (hh === false && hl) label = 'triângulo/compressão (topos caindo, fundos subindo)';
  else if (hh && hl === false) label = 'expansão/volatilidade (topos subindo, fundos caindo)';
  return { hh, hl, label, lastTops: t2, lastBottoms: b2 };
}

const pct = (a, b) => (a / b - 1) * 100;

function analyze(candles) {
  if (!candles || candles.length < 60) return { ok: false, error: 'Histórico insuficiente para análise técnica.' };
  const closes = candles.map((x) => x.c);
  const vols = candles.map((x) => x.v);
  const n = candles.length;
  const e8 = ema(closes, 8), e20 = ema(closes, 20), s200 = sma(closes, 200), s50 = sma(closes, 50);
  const r = rsi(closes, 14), a = atr(candles, 14);
  const hv20 = histVol(closes, 20), hv60 = histVol(closes, 60);
  const vAvg20 = sma(vols, 20);
  const last = candles[n - 1];
  const price = last.c;
  const L = (arr) => arr[n - 1];
  const slope = (arr, k = 5) => (arr[n - 1] != null && arr[n - 1 - k] != null ? pct(arr[n - 1], arr[n - 1 - k]) : null);

  const lv = levels(candles);
  const supports = lv.filter((x) => x.price < price).sort((x, y) => y.price - x.price).slice(0, 3);
  const resistances = lv.filter((x) => x.price > price).sort((x, y) => x.price - y.price).slice(0, 3);
  const year = candles.slice(-252);
  const hi52 = Math.max(...year.map((x) => x.h)), lo52 = Math.min(...year.map((x) => x.l));
  const hi20 = Math.max(...candles.slice(-21, -1).map((x) => x.h)), lo20 = Math.min(...candles.slice(-21, -1).map((x) => x.l));
  const st = structure(candles);

  // Cruzamento recente MME8 x MME20 (últimos 5 pregões)
  let cross = null;
  for (let i = n - 5; i < n; i++) {
    if (e8[i - 1] == null || e20[i - 1] == null) continue;
    if (e8[i - 1] <= e20[i - 1] && e8[i] > e20[i]) cross = { type: 'alta', barsAgo: n - 1 - i };
    if (e8[i - 1] >= e20[i - 1] && e8[i] < e20[i]) cross = { type: 'baixa', barsAgo: n - 1 - i };
  }

  // ---------- Pontuação técnica (-100 a +100) ----------
  const parts = [];
  const add = (name, val, why) => parts.push({ name, val, why });
  const has200 = L(s200) != null;
  if (has200) add('Preço vs MMA200', price > L(s200) ? 20 : -20, `preço ${price > L(s200) ? 'acima' : 'abaixo'} da MMA200 (${pct(price, L(s200)).toFixed(1)}%)`);
  add('Preço vs MME20', price > L(e20) ? 12 : -12, `preço ${price > L(e20) ? 'acima' : 'abaixo'} da MME20`);
  add('MME8 vs MME20', L(e8) > L(e20) ? 12 : -12, `MME8 ${L(e8) > L(e20) ? 'acima' : 'abaixo'} da MME20`);
  const s20 = slope(e20);
  if (s20 != null) add('Inclinação MME20', Math.max(-10, Math.min(10, s20 * 4)), `MME20 ${s20 >= 0 ? 'subindo' : 'caindo'} (${s20.toFixed(2)}% em 5 pregões)`);
  if (has200) {
    const s2 = slope(s200, 20);
    if (s2 != null) add('Inclinação MMA200', s2 > 0.3 ? 8 : s2 < -0.3 ? -8 : 0, `MMA200 ${s2 > 0.3 ? 'ascendente' : s2 < -0.3 ? 'descendente' : 'lateral'}`);
  }
  if (st.hh != null && st.hl != null) add('Estrutura', st.hh && st.hl ? 14 : !st.hh && !st.hl ? -14 : 0, st.label);
  const rr = L(r);
  if (rr != null) {
    let v = 0, why = `IFR14 em ${rr.toFixed(0)}`;
    if (rr > 75) { v = -8; why += ' (sobrecomprado: risco de realização)'; }
    else if (rr < 25) { v = 8; why += ' (sobrevendido: risco de repique)'; }
    else if (rr > 55) { v = 6; why += ' (momento comprador)'; }
    else if (rr < 45) { v = -6; why += ' (momento vendedor)'; }
    add('IFR14', v, why);
  }
  if (price > hi20) add('Rompimento', 10, `rompeu máxima de 20 pregões (${hi20.toFixed(2)})`);
  else if (price < lo20) add('Rompimento', -10, `perdeu mínima de 20 pregões (${lo20.toFixed(2)})`);
  const volRatio = L(vAvg20) ? last.v / L(vAvg20) : null;
  const dayChg = pct(price, candles[n - 2].c);
  if (volRatio && volRatio > 1.6) add('Volume', dayChg >= 0 ? 6 : -6, `volume ${volRatio.toFixed(1)}x a média de 20 pregões em dia de ${dayChg >= 0 ? 'alta' : 'queda'} (convicção)`);

  const score = Math.max(-100, Math.min(100, parts.reduce((s, p) => s + p.val, 0)));
  let trend = 'lateral';
  if (score >= 45) trend = 'alta forte';
  else if (score >= 15) trend = 'alta';
  else if (score <= -45) trend = 'baixa forte';
  else if (score <= -15) trend = 'baixa';

  const hvNow = L(hv20);
  const hvPct = hvNow != null ? percentileRank(hv20.slice(-252), hvNow) : null;
  const atrNow = L(a);

  const ns = supports[0], nr = resistances[0];
  const lines = [];
  lines.push(`Tendência ${trend} (pontuação técnica ${score > 0 ? '+' : ''}${score.toFixed(0)}). ${st.label[0].toUpperCase() + st.label.slice(1)}.`);
  lines.push(`Médias: MME8 ${L(e8).toFixed(2)} · MME20 ${L(e20).toFixed(2)}${has200 ? ` · MMA200 ${L(s200).toFixed(2)}` : ''}. ${cross ? `Cruzamento de ${cross.type} da MME8 sobre a MME20 há ${cross.barsAgo} pregão(ões).` : ''}`);
  if (ns || nr) lines.push(`Suporte mais próximo ${ns ? `${ns.price.toFixed(2)} (${pct(ns.price, price).toFixed(1)}%, ${ns.touches} toque(s))` : `nenhum pivô abaixo — preço em região de mínimas (referência: mínima de 52 semanas ${lo52.toFixed(2)})`}; resistência ${nr ? `${nr.price.toFixed(2)} (+${pct(nr.price, price).toFixed(1)}%, ${nr.touches} toque(s))` : '—'}.`);
  lines.push(`Faixa de 52 semanas: ${lo52.toFixed(2)} – ${hi52.toFixed(2)} (preço a ${pct(price, hi52).toFixed(1)}% da máxima). ATR14 ${atrNow.toFixed(2)} (${((atrNow / price) * 100).toFixed(1)}% do preço).`);
  if (rr != null) lines.push(`IFR14 ${rr.toFixed(0)}. Vol. histórica 20d ${(hvNow * 100).toFixed(1)}% (percentil ${hvPct != null ? hvPct.toFixed(0) : '—'} do último ano).`);

  return {
    ok: true,
    price,
    dayChg,
    score,
    trend,
    parts,
    ma: { e8: L(e8), e20: L(e20), s50: L(s50), s200: L(s200) },
    rsi: rr,
    atr: atrNow,
    hv20: hvNow,
    hv60: L(hv60),
    hvPct,
    volRatio,
    hi52, lo52, hi20, lo20,
    supports, resistances,
    structure: st,
    cross,
    diagnosis: lines,
    series: {
      e8: e8.map((v, i) => (v == null ? null : { time: candles[i].t, value: v })).filter(Boolean),
      e20: e20.map((v, i) => (v == null ? null : { time: candles[i].t, value: v })).filter(Boolean),
      s200: s200.map((v, i) => (v == null ? null : { time: candles[i].t, value: v })).filter(Boolean),
    },
  };
}

module.exports = { analyze, sma, ema, rsi, atr, histVol, percentileRank };
