'use strict';
const test = require('node:test');
const assert = require('node:assert');
const bs = require('../src/quant/bs');
const ta = require('../src/quant/ta');
const { runGuards } = require('../src/quant/guards');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test('Black-Scholes: valores de referência (Hull)', () => {
  near(bs.price('call', 100, 100, 1, 0.05, 0.2), 10.4506, 1e-3, 'call');
  near(bs.price('put', 100, 100, 1, 0.05, 0.2), 5.5735, 1e-3, 'put');
});

test('Paridade put-call', () => {
  for (const [S, K, T, r, s, q] of [[42.67, 40, 0.15, 0.13, 0.4, 0.08], [28.5, 30, 0.08, 0.04, 0.39, 0.05]]) {
    const c = bs.price('call', S, K, T, r, s, q), p = bs.price('put', S, K, T, r, s, q);
    near(c - p, S * Math.exp(-q * T) - K * Math.exp(-r * T), 1e-9, 'paridade');
  }
});

test('VI recupera a vol usada no preço', () => {
  const p = bs.price('put', 58.48, 56, 0.12, 0.128, 0.37, 0.06);
  near(bs.impliedVol('put', p, 58.48, 56, 0.12, 0.128, 0.06), 0.37, 1e-4, 'iv');
  assert.strictEqual(bs.impliedVol('call', 0.0001, 100, 50, 0.5, 0.05), null, 'preço abaixo do intrínseco deve ser rejeitado');
});

test('Gregas conferem com diferenças finitas', () => {
  const S = 40, K = 41, T = 0.1, r = 0.13, s = 0.45, q = 0.05, h = 1e-3;
  for (const type of ['call', 'put']) {
    const g = bs.greeks(type, S, K, T, r, s, q);
    near(g.delta, (bs.price(type, S + h, K, T, r, s, q) - bs.price(type, S - h, K, T, r, s, q)) / (2 * h), 1e-5, `delta ${type}`);
    near(g.vega, (bs.price(type, S, K, T, r, s + 1e-4, q) - bs.price(type, S, K, T, r, s - 1e-4, q)) / 2e-4 / 100, 1e-5, `vega ${type}`);
    near(g.theta, -(bs.price(type, S, K, T, r, s, q) - bs.price(type, S, K, T - 1 / 365, r, s, q)), 2e-3, `theta ${type}`);
  }
});

test('Grade lognormal soma 1 e tem média forward', () => {
  const g = bs.lognormalGrid(100, 0.5, 0.3, 0.05);
  near(g.reduce((a, p) => a + p.w, 0), 1, 1e-9, 'soma');
  near(g.reduce((a, p) => a + p.w * p.s, 0), 100 * Math.exp(0.05 * 0.5), 0.15, 'média');
});

test('Médias móveis', () => {
  const x = [1, 2, 3, 4, 5, 6];
  assert.deepStrictEqual(ta.sma(x, 3).slice(2), [2, 3, 4, 5]);
  near(ta.ema(x, 3)[5], 5, 1e-9, 'ema de série linear converge');
});

test('Anti-erro bloqueia venda descoberta e posição sem caixa', () => {
  const a = { family: 'venda-descoberta', key: 'short_call', debit: false, cost: -1, maxLoss: -Infinity, maxProfit: 1, unlimitedLoss: true, legs: [{ type: 'call', side: -1, strike: 46, mid: 0.6, dte: 28, spreadPct: null }], greeks: { delta: -0.25, vega: -0.05, theta: 0.01 }, lots: 0, riskPerLot: Infinity, maxRiskBRL: 2000, lot: 100 };
  const ctx = { S: 42, market: 'B3', regime: { stress: false }, q: 0, maxRiskPct: 2, events: [] };
  const r = runGuards(a, ctx, { bias: -40, label: 'baixista' }, {}, { real: false });
  assert.ok(r.blocked);
  assert.ok(r.blocks.some((b) => /ilimitada/.test(b)));
});

test('EWMA de retornos constantes tende ao desvio correto', () => {
  // retornos alternando ±1% => vol diária 1% => anual ≈ 15,87%
  const c = [100];
  for (let i = 0; i < 400; i++) c.push(c[c.length - 1] * Math.exp(i % 2 ? 0.01 : -0.01));
  near(ta.ewmaVol(c), 0.01 * Math.sqrt(252), 1e-3, 'ewma');
});

test('Auditoria: classifica vantagem, ausência e sinal contrário', () => {
  const mk = (hit, base, n, nEff) => ({ ok: true, horizon: 10, years: 4, samples: 1000, baseUp: base, buckets: [
    { id: 'bf', label: 'baixa forte', dir: -1, n, nEff, hit, base: 1 - base, edge: hit - (1 - base), z: (hit - (1 - base)) / Math.sqrt((base * (1 - base)) / nEff), avgFwd: 0 },
    { id: 'n', label: 'lateral', dir: 0, n: 10 }] });
  assert.strictEqual(ta.calibVerdict(mk(0.70, 0.5, 200, 40), -80).status, 'edge');
  assert.strictEqual(ta.calibVerdict(mk(0.52, 0.5, 200, 40), -80).status, 'noedge');
  assert.strictEqual(ta.calibVerdict(mk(0.30, 0.5, 200, 40), -80).status, 'contrary');
  assert.strictEqual(ta.calibVerdict(mk(0.90, 0.5, 10, 3), -80).status, 'unknown');
});

test('Auditoria não olha o futuro: alterar candles futuros não muda a pontuação do passado', () => {
  const base = [];
  let p = 50;
  for (let i = 0; i < 400; i++) { p *= 1 + Math.sin(i / 9) * 0.01; base.push({ t: i * 86400, o: p, h: p * 1.01, l: p * 0.99, c: p, v: 1000 }); }
  const a = ta.analyze(base.slice(0, 300), { lite: true }).score;
  const mod = base.map((x, i) => (i >= 300 ? { ...x, c: x.c * 3, h: x.h * 3, l: x.l * 3, o: x.o * 3 } : x));
  const b = ta.analyze(mod.slice(0, 300), { lite: true }).score;
  assert.strictEqual(a, b);
});

test('Macro calibrado: índice central e entrada na abertura seguinte (sem olhar o futuro)', () => {
  const mc = require('../src/quant/macrocal');
  // VIX 36 (-25) subindo 26% (-8), DXY 0, BRL +1,14% (-9,12), 10a -14bps (+8), S&P -3,7% (-10)
  near(mc.coreScore({ vix: 36, vixChg: 26, dxyChg: 0, brlChg: 1.14, tnxBps: -14, spxChg: -3.7 }), -44.12, 1e-9, 'core');
  assert.strictEqual(mc.coreScore({ vix: 20 }), null, 'menos de 3 componentes => sem leitura');
  // série sintética: regime sempre neutro; retorno medido de open(i+1) até close(i+10)
  const day = 86400;
  const regime = new Map();
  const candles = [];
  for (let i = 0; i < 400; i++) {
    const d = new Date(Date.UTC(2024, 0, 1) + i * day * 1000).toISOString().slice(0, 10);
    regime.set(d, 0);
    candles.push({ t: Date.UTC(2024, 0, 1) / 1000 + i * day, o: 100 + i + 0.5, c: 100 + i, h: 101 + i, l: 99 + i, v: 1 });
  }
  const cal = mc.calibrateAsset(regime, { meta: { gmtoffset: 0 }, candles }, 10);
  const nb = cal.buckets.find((b) => b.id === 'ne');
  // média esperada: média de (100+i+10)/(100+i+1.5) - 1 — se usasse close(i) seria maior
  let exp = 0, k = 0;
  for (let i = 0; i < 400 - 11; i++) { exp += (100 + i + 10) / (100 + i + 1 + 0.5) - 1; k++; }
  near(nb.avgFwd, (exp / k) * 100, 1e-9, 'entrada na abertura seguinte');
});
