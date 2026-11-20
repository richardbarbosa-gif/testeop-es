'use strict';
// Calibração do MACRO por ativo.
// Reconstrói, dia a dia nos últimos ~5 anos, o "índice de regime central" com as mesmas regras
// do termômetro (VIX nível/variação, DXY, USD/BRL, Treasury 10a, S&P 500) e mede o que cada ativo
// fez nos h pregões seguintes, com ENTRADA NA ABERTURA SEGUINTE (o macro do dia só é conhecido
// após o fechamento americano — entrar no fechamento do mesmo dia seria olhar o futuro).
// Resultado: retorno médio por faixa de regime e o quanto ele difere da média incondicional
// (escore-z com episódios independentes). Nada de "aversão a risco = baixa" por suposição.

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

function coreScore({ vix, vixChg, dxyChg, brlChg, tnxBps, spxChg }) {
  let s = 0, k = 0;
  if (Number.isFinite(vix)) {
    s += vix < 14 ? 10 : vix < 18 ? 5 : vix < 22 ? 0 : vix < 28 ? -10 : vix < 35 ? -18 : -25;
    if (Number.isFinite(vixChg)) s += vixChg > 10 ? -8 : vixChg < -8 ? 5 : 0;
    k++;
  }
  if (Number.isFinite(dxyChg)) { s += clamp(-dxyChg * 15, -10, 10); k++; }
  if (Number.isFinite(brlChg)) { s += clamp(-brlChg * 8, -12, 12); k++; }
  if (Number.isFinite(tnxBps)) { s += clamp(-tnxBps * 0.6, -8, 8); k++; }
  if (Number.isFinite(spxChg)) { s += clamp(spxChg * 6, -10, 10); k++; }
  return k >= 3 ? s : null;
}

const BUCKETS = [
  { id: 'av', label: 'aversão a risco', min: -999, max: -25 },
  { id: 'ca', label: 'cautela', min: -25, max: -8 },
  { id: 'ne', label: 'neutro', min: -8, max: 8 },
  { id: 'po', label: 'positivo', min: 8, max: 25 },
  { id: 'ap', label: 'apetite a risco', min: 25, max: 999 },
];
const bucketOf = (s) => BUCKETS.find((b) => s > b.min && s <= b.max) || BUCKETS[2];

function dayOf(t, off) {
  return new Date((t + (off || 0)) * 1000).toISOString().slice(0, 10);
}

function toDayMap(hist) {
  const off = hist.meta && hist.meta.gmtoffset;
  const m = new Map();
  const c = hist.candles;
  for (let i = 1; i < c.length; i++) m.set(dayOf(c[i].t, off), { c: c[i].c, prev: c[i - 1].c });
  return m;
}

// histories: { vix, dxy, brl, tnx, spx } (saída de yahoo.history)
function buildRegimeHistory(h) {
  const maps = Object.fromEntries(Object.entries(h).map(([k, v]) => [k, toDayMap(v)]));
  const days = [...maps.spx.keys()].sort();
  const allKeys = {};
  for (const k of Object.keys(maps)) allKeys[k] = [...maps[k].keys()].sort();
  // valor no dia ou no último dia anterior (até 4 dias corridos)
  const at = (k, d) => {
    const v = maps[k].get(d);
    if (v) return v;
    const ks = allKeys[k];
    let lo = 0, hi = ks.length - 1, best = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (ks[mid] <= d) { best = ks[mid]; lo = mid + 1; } else hi = mid - 1; }
    if (!best || (Date.parse(d) - Date.parse(best)) / 86400e3 > 4) return null;
    return maps[k].get(best);
  };
  const out = new Map();
  for (const d of days) {
    const vix = at('vix', d), dxy = at('dxy', d), brl = at('brl', d), tnx = at('tnx', d), spx = maps.spx.get(d);
    const pc = (x) => (x && x.prev ? (x.c / x.prev - 1) * 100 : null);
    const score = coreScore({
      vix: vix ? vix.c : null, vixChg: pc(vix), dxyChg: pc(dxy), brlChg: pc(brl),
      tnxBps: tnx ? (tnx.c - tnx.prev) * 100 : null, spxChg: pc(spx),
    });
    if (score != null) out.set(d, score);
  }
  return out;
}

function calibrateAsset(regime, assetHist, horizon = 10) {
  const off = assetHist.meta && assetHist.meta.gmtoffset;
  const c = assetHist.candles;
  const rDays = [...regime.keys()].sort();
  const lastRegimeOnOrBefore = (d) => {
    let lo = 0, hi = rDays.length - 1, best = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (rDays[mid] <= d) { best = rDays[mid]; lo = mid + 1; } else hi = mid - 1; }
    if (!best || (Date.parse(d) - Date.parse(best)) / 86400e3 > 4) return null;
    return regime.get(best);
  };
  const samples = [];
  for (let i = 0; i < c.length - horizon - 1; i++) {
    const s = lastRegimeOnOrBefore(dayOf(c[i].t, off));
    if (s == null || !(c[i + 1].o > 0)) continue;
    samples.push({ i, score: s, fwd: c[i + horizon].c / c[i + 1].o - 1 });
  }
  if (samples.length < 200) return { ok: false, reason: 'histórico insuficiente para calibrar o macro', samples: samples.length };
  const mean = samples.reduce((a, x) => a + x.fwd, 0) / samples.length;
  const sd = Math.sqrt(samples.reduce((a, x) => a + (x.fwd - mean) ** 2, 0) / (samples.length - 1));
  const buckets = BUCKETS.map((b) => {
    const xs = samples.filter((x) => x.score > b.min && x.score <= b.max);
    if (!xs.length) return { ...b, n: 0 };
    // Amostras independentes = janelas que não se sobrepõem (escolha gulosa, espaçamento >= h).
    let nEff = 0, lastI = -1e9;
    for (const x of xs) if (x.i - lastI >= horizon) { nEff++; lastI = x.i; }
    const m = xs.reduce((a, x) => a + x.fwd, 0) / xs.length;
    const up = xs.filter((x) => x.fwd > 0).length / xs.length;
    return { ...b, n: xs.length, nEff: +nEff.toFixed(1), avgFwd: m * 100, upRate: up, zMean: (m - mean) / (sd / Math.sqrt(nEff)) };
  });
  return { ok: true, horizon, samples: samples.length, years: +(samples.length / 252).toFixed(1), meanAll: mean * 100, buckets };
}

function verdict(cal, scoreNow) {
  if (scoreNow == null) return { status: 'unknown', msg: 'Regime atual indisponível.' };
  const b = cal && cal.ok ? cal.buckets.find((x) => x.id === bucketOf(scoreNow).id) : null;
  if (!b) return { status: 'unknown', msg: 'Sem calibração macro (histórico insuficiente).' };
  if (b.n < 25 || b.nEff < 6) return { status: 'unknown', bucket: b, scoreNow, msg: `Regime "${b.label}" ocorreu ${b.n} vezes (~${Math.round(b.nEff)} janelas independentes) em ${cal.years} anos: amostra insuficiente.` };
  const pp = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`;
  const txt = `Em ${cal.years} anos, em regime "${b.label}" (índice central ${scoreNow.toFixed(0)}), o ativo rendeu em média ${pp(b.avgFwd)} nos ${cal.horizon} pregões seguintes, contra ${pp(cal.meanAll)} em qualquer dia (subiu em ${(b.upRate * 100).toFixed(0)}% das vezes; ~${Math.round(b.nEff)} janelas independentes; z=${b.zMean.toFixed(2)}).`;
  const sh = `em regime de "${b.label}" o ativo rendeu em média ${pp(b.avgFwd)} nos ${cal.horizon} pregões seguintes (normal: ${pp(cal.meanAll)})`;
  if (b.zMean >= 1) return { status: 'bull', bucket: b, scoreNow, msg: `${txt} Historicamente FAVORÁVEL à alta.`, short: `${sh} — historicamente FAVORÁVEL à alta.` };
  if (b.zMean <= -1) return { status: 'bear', bucket: b, scoreNow, msg: `${txt} Historicamente DESFAVORÁVEL (queda).`, short: `${sh} — historicamente DESFAVORÁVEL.` };
  return { status: 'noedge', bucket: b, scoreNow, msg: `${txt} Sem efeito estatisticamente distinguível.`, short: `${sh} — diferença dentro do acaso.` };
}

module.exports = { coreScore, buildRegimeHistory, calibrateAsset, verdict, bucketOf, BUCKETS };
