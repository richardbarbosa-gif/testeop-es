'use strict';
// Motor de estratégias.
// 1) Visão direcional = técnico + macro + "lead" (ADR no after / commodity) + notícias.
// 2) Visão de volatilidade = VI vs vol. histórica (+ percentil).
// 3) Gera candidatas reais a partir da grade, calcula payoff/gregas/probabilidades.
// 4) Pontua cada uma pela aderência ao cenário e submete à camada anti-erro (guards).
// 5) Recomenda a melhor APROVADA — ou "NÃO OPERAR".
const bs = require('./bs');
const { runGuards, contextGuards } = require('./guards');

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// ---------------- Visões ----------------
function directionalView(ctx) {
  const { ta, regime, lead, newsTag } = ctx;
  const comps = [];
  comps.push({ id: 'tech', label: 'Técnico (gráfico)', score: ta.score, w: 0.5 });
  comps.push({ id: 'macro', label: 'Macro / regime de risco', score: regime.score, w: 0.25 });
  if (lead && Number.isFinite(lead.score)) comps.push({ id: 'lead', label: lead.label, score: lead.score, w: 0.15 });
  if (newsTag && newsTag.n >= 3) comps.push({ id: 'news', label: `Notícias (${newsTag.n} manchetes)`, score: clamp((newsTag.s / newsTag.n) * 40, -100, 100), w: 0.1 });
  const wsum = comps.reduce((a, c) => a + c.w, 0);
  const bias = comps.reduce((a, c) => a + c.score * c.w, 0) / wsum;
  const sgn = Math.sign(bias);
  const active = comps.filter((c) => Math.abs(c.score) >= 8);
  const agreement = active.length ? active.filter((c) => Math.sign(c.score) === sgn).reduce((a, c) => a + c.w, 0) / active.reduce((a, c) => a + c.w, 0) : 0;
  const quorumF = clamp((regime.quorum || 0) / 100, 0.5, 1);
  let confidence = Math.min(100, Math.abs(bias) * 1.7) * (0.4 + 0.6 * agreement) * quorumF * (regime.stress ? 0.8 : 1);
  confidence = Math.round(clamp(confidence, 0, 100));
  let label = 'neutra';
  if (bias >= 15) label = bias >= 40 ? 'altista forte' : 'altista';
  else if (bias <= -15) label = bias <= -40 ? 'baixista forte' : 'baixista';
  // Conflito: técnico e macro fortes em sentidos opostos.
  const conflict = Math.abs(ta.score) >= 30 && Math.abs(regime.score) >= 30 && Math.sign(ta.score) !== Math.sign(regime.score);
  return { bias: Math.round(bias), label, confidence, agreement: Math.round(agreement * 100), comps, conflict };
}

function volView(ctx, chain) {
  const { ta } = ctx;
  const exp = pickExpiry(chain, 25, 60, 40);
  let atmIv = null;
  if (exp) {
    const atm = exp.options.filter((o) => o.iv).sort((a, b) => Math.abs(a.strike - ctx.S) - Math.abs(b.strike - ctx.S)).slice(0, 4);
    if (atm.length) atmIv = atm.reduce((a, o) => a + o.iv, 0) / atm.length;
  }
  const hv = ta.hv20, hvPct = ta.hvPct;
  const ratio = atmIv && hv ? atmIv / hv : null;
  const ivRank = ctx.ivHistory ? ctx.ivHistory.rank : null;
  let label = 'justa';
  if ((ratio && ratio > 1.25) || (ivRank != null && ivRank > 65)) label = 'cara';
  else if (ratio && ratio < 0.95 && (hvPct == null || hvPct < 55) && (ivRank == null || ivRank < 40)) label = 'barata';
  return { atmIv, hv20: hv, hv60: ta.hv60, hvPct, ratio, ivRank, label, expiry: exp ? exp.date : null, theoretical: !chain.real };
}

// ---------------- Seleção na grade ----------------
function pickExpiry(chain, min, max, prefer) {
  const xs = chain.expirations.filter((e) => e.dte >= min && e.dte <= max && e.options.length);
  if (!xs.length) return null;
  return xs.sort((a, b) => Math.abs(a.dte - prefer) - Math.abs(b.dte - prefer))[0];
}

function byDelta(exp, type, target, filter = () => true) {
  const xs = exp.options.filter((o) => o.type === type && o.mid > 0 && o.delta != null && filter(o));
  if (!xs.length) return null;
  return xs.sort((a, b) => Math.abs(Math.abs(a.delta) - target) - Math.abs(Math.abs(b.delta) - target))[0];
}

function byStrike(exp, type, K) {
  const xs = exp.options.filter((o) => o.type === type && o.mid > 0);
  if (!xs.length) return null;
  return xs.sort((a, b) => Math.abs(a.strike - K) - Math.abs(b.strike - K))[0];
}

const leg = (o, side) => ({ ...o, side }); // side: +1 compra, -1 venda

// ---------------- Construtores de estratégias ----------------
function buildCandidates(ctx, chain, dir) {
  const S = ctx.S;
  const out = [];
  const bull = dir.bias > 0;
  const t = bull ? 'call' : 'put';
  const width = (exp) => Math.max(ctx.strikeStep, Math.round((S * 0.04) / ctx.strikeStep) * ctx.strikeStep);

  if (Math.abs(dir.bias) >= 10) {
    const e1 = pickExpiry(chain, 28, 75, 45);
    if (e1) {
      const o = byDelta(e1, t, 0.45);
      if (o) out.push({ key: `long_${t}`, name: bull ? 'Compra de call' : 'Compra de put', family: 'direcional-debito', legs: [leg(o, 1)] });
      const l = byDelta(e1, t, 0.5);
      if (l) {
        const sK = bull ? l.strike + width(e1) : l.strike - width(e1);
        const s = byStrike(e1, t, sK);
        if (s && s.strike !== l.strike) out.push({ key: `debit_${t}`, name: bull ? 'Trava de alta com calls (débito)' : 'Trava de baixa com puts (débito)', family: 'trava-debito', legs: [leg(l, 1), leg(s, -1)] });
      }
    }
    const e2 = pickExpiry(chain, 21, 50, 35);
    if (e2) {
      const ct = bull ? 'put' : 'call';
      const s = byDelta(e2, ct, 0.28);
      if (s) {
        const lK = bull ? s.strike - width(e2) : s.strike + width(e2);
        const l = byStrike(e2, ct, lK);
        if (l && l.strike !== s.strike) out.push({ key: `credit_${ct}`, name: bull ? 'Trava de alta com puts (crédito)' : 'Trava de baixa com calls (crédito)', family: 'trava-credito', legs: [leg(s, -1), leg(l, 1)] });
        if (bull) out.push({ key: 'short_put', name: 'Venda de put coberta por caixa', family: 'venda-coberta', legs: [leg(s, -1)] });
      }
      if (!bull) {
        const sc = byDelta(e2, 'call', 0.28);
        if (sc) out.push({ key: 'short_call', name: 'Venda de call a seco', family: 'venda-descoberta', legs: [leg(sc, -1)] });
      }
    }
    const front = pickExpiry(chain, 18, 40, 28);
    const back = pickExpiry(chain, 55, 120, 75);
    if (front && back && back.date !== front.date) {
      const l = byDelta(back, t, 0.6);
      const s = l && byDelta(front, t, 0.3, (o) => (bull ? o.strike > l.strike : o.strike < l.strike));
      if (l && s) out.push({ key: `diag_${t}`, name: bull ? 'Diagonal de alta com calls' : 'Diagonal de baixa com puts', family: 'diagonal', legs: [leg(l, 1), leg(s, -1)] });
    }
  }
  if (Math.abs(dir.bias) < 25) {
    const e = pickExpiry(chain, 25, 55, 38);
    if (e) {
      const sp = byDelta(e, 'put', 0.18), sc = byDelta(e, 'call', 0.18);
      if (sp && sc) {
        const lp = byStrike(e, 'put', sp.strike - width(e)), lc = byStrike(e, 'call', sc.strike + width(e));
        if (lp && lc && lp.strike < sp.strike && lc.strike > sc.strike) out.push({ key: 'condor', name: 'Iron condor (venda de volatilidade com risco definido)', family: 'neutra-credito', legs: [leg(lp, 1), leg(sp, -1), leg(sc, -1), leg(lc, 1)] });
      }
      const ac = byDelta(e, 'call', 0.5), ap = byDelta(e, 'put', 0.5);
      if (ac && ap) out.push({ key: 'straddle', name: 'Compra de straddle (aposta em movimento forte)', family: 'neutra-debito', legs: [leg(ac, 1), leg(ap, 1)] });
    }
    const front = pickExpiry(chain, 18, 40, 28), back = pickExpiry(chain, 50, 120, 70);
    if (front && back && front.date !== back.date) {
      const s = byDelta(front, 'call', 0.5);
      const l = s && byStrike(back, 'call', s.strike);
      if (s && l) out.push({ key: 'calendar', name: 'Calendário com calls (ATM)', family: 'calendario', legs: [leg(l, 1), leg(s, -1)] });
    }
  }
  return out;
}

// ---------------- Métricas ----------------
function analyzeCandidate(c, ctx, dir, vol) {
  const S = ctx.S;
  const lot = ctx.market === 'US' ? 100 : 100; // contrato EUA = 100 ações; lote padrão B3 = 100 opções
  const horizon = Math.min(...c.legs.map((l) => l.dte));
  const cost = c.legs.reduce((a, l) => a + l.side * l.mid, 0); // >0 = débito
  const valueAt = (ST, daysFwd) =>
    c.legs.reduce((a, l) => {
      const rem = Math.max(0, l.dte - daysFwd) / 365;
      const v = rem <= 1e-6 ? Math.max(0, l.type === 'call' ? ST - l.strike : l.strike - ST) : bs.price(l.type, ST, l.strike, rem, ctx.r, l.iv || vol.atmIv || ctx.ivFallback, ctx.q);
      return a + l.side * v;
    }, 0);
  const pnlAt = (ST, d) => valueAt(ST, d) - cost;

  const lo = S * 0.55, hi = S * 1.5, N = 300;
  const grid = [];
  for (let i = 0; i <= N; i++) {
    const s = lo + ((hi - lo) * i) / N;
    grid.push({ s, exp: pnlAt(s, horizon), now: pnlAt(s, 0) });
  }
  let maxP = Math.max(...grid.map((g) => g.exp)), maxL = Math.min(...grid.map((g) => g.exp));
  // Risco ilimitado / grande: inclinação nas bordas
  const slopeHi = grid[N].exp - grid[N - 1].exp, slopeLo = grid[1].exp - grid[0].exp;
  const unlimitedLoss = slopeHi < -1e-6 && c.legs.some((l) => l.type === 'call' && l.side < 0) && c.legs.filter((l) => l.type === 'call').reduce((a, l) => a + l.side, 0) < 0;
  const unlimitedGain = slopeHi > 1e-6 && c.legs.filter((l) => l.type === 'call').reduce((a, l) => a + l.side, 0) > 0;
  if (c.key === 'short_put') maxL = Math.min(maxL, pnlAt(0.0001, horizon)); // até zero
  const bes = [];
  for (let i = 1; i <= N; i++) if (Math.sign(grid[i].exp) !== Math.sign(grid[i - 1].exp) && grid[i - 1].exp !== 0) bes.push(+(grid[i - 1].s + ((grid[i].s - grid[i - 1].s) * -grid[i - 1].exp) / (grid[i].exp - grid[i - 1].exp)).toFixed(2));

  const sigma = vol.atmIv || ctx.ivFallback;
  const T = horizon / 365;
  const rn = bs.lognormalGrid(S, T, sigma, ctx.r - ctx.q);
  const pop = rn.reduce((a, p) => a + (pnlAt(p.s, horizon) > 0 ? p.w : 0), 0);
  // Cenário do sistema: desloca a média em até 0,25 desvio conforme o viés (modesto de propósito).
  const tilt = (dir.bias / 100) * 0.25 * sigma * Math.sqrt(T);
  const sys = bs.lognormalGrid(S * Math.exp(tilt), T, sigma, ctx.r - ctx.q);
  const evSys = sys.reduce((a, p) => a + pnlAt(p.s, horizon) * p.w, 0);
  const popSys = sys.reduce((a, p) => a + (pnlAt(p.s, horizon) > 0 ? p.w : 0), 0);

  const g = c.legs.reduce((a, l) => ({
    delta: a.delta + l.side * (l.delta || 0),
    gamma: a.gamma + l.side * (l.gamma || 0),
    theta: a.theta + l.side * (l.theta || 0),
    vega: a.vega + l.side * (l.vega || 0),
  }), { delta: 0, gamma: 0, theta: 0, vega: 0 });

  const expMove = S * sigma * Math.sqrt(T);
  const nearestBe = bes.length ? bes.reduce((a, b) => (Math.abs(b - S) < Math.abs(a - S) ? b : a)) : null;
  const beMove = nearestBe ? Math.abs(nearestBe - S) : null;
  const maxLossAbs = unlimitedLoss ? Infinity : Math.abs(Math.min(0, maxL));
  const rr = maxLossAbs && Number.isFinite(maxLossAbs) && maxLossAbs > 0 ? maxP / maxLossAbs : null;
  const widthCredit = c.family === 'trava-credito' ? Math.abs(c.legs[0].strike - c.legs[1].strike) : null;

  // Dimensionamento
  const fx = ctx.market === 'US' ? ctx.usdbrl || 5.5 : 1;
  const maxRiskBRL = (ctx.capital * ctx.maxRiskPct) / 100;
  let riskPerLot = maxLossAbs * lot * fx;
  if (c.key === 'short_put') riskPerLot = c.legs[0].strike * lot * fx; // caixa necessário
  const lots = Number.isFinite(riskPerLot) && riskPerLot > 0 ? Math.floor((c.key === 'short_put' ? ctx.capital * 0.25 : maxRiskBRL) / riskPerLot) : 0;

  const payoff = grid.filter((_, i) => i % 3 === 0).map((p) => ({ s: +p.s.toFixed(2), exp: +(p.exp * lot).toFixed(2), now: +(p.now * lot).toFixed(2) }));

  return {
    ...c,
    horizon: Math.round(horizon),
    cost,
    debit: cost > 0,
    maxProfit: unlimitedGain ? Infinity : maxP,
    maxLoss: unlimitedLoss ? -Infinity : maxL,
    unlimitedLoss,
    unlimitedGain,
    breakevens: bes,
    pop,
    popSys,
    evSys,
    rr,
    widthCredit,
    greeks: g,
    expMove,
    beMove,
    beVsExpMove: beMove != null && expMove ? beMove / expMove : null,
    lot,
    fx,
    riskPerLot,
    lots,
    maxRiskBRL,
    payoff,
  };
}

// ---------------- Pontuação ----------------
function scoreCandidate(a, dir, vol, ctx) {
  let s = 50;
  const why = [];
  const add = (v, msg) => { s += v; why.push({ v, msg }); };
  const conf = dir.confidence;
  const directional = !['neutra-credito', 'neutra-debito', 'calendario'].includes(a.family);

  if (directional) {
    if (Math.abs(dir.bias) < 15) add(-15, 'cenário sem direção clara para estrutura direcional');
    if (conf >= 65) {
      if (a.family === 'direcional-debito') add(12, 'convicção alta favorece exposição direcional plena');
      if (a.family === 'trava-debito') add(8, 'trava captura o movimento com custo menor');
      if (a.family === 'trava-credito' || a.family === 'diagonal') add(4, 'estrutura alinhada ao viés');
    } else {
      if (a.family === 'trava-debito') add(10, 'convicção moderada: trava limita custo e risco');
      if (a.family === 'trava-credito') add(10, 'convicção moderada: crédito ganha com tempo e com o ativo parado ou a favor');
      if (a.family === 'diagonal') add(8, 'diagonal: viés moderado com financiamento pela série curta');
      if (a.family === 'direcional-debito') add(-4, 'compra seca exige movimento forte e rápido');
    }
  } else {
    if (Math.abs(dir.bias) < 15) add(10, 'cenário neutro favorece estruturas sem direção');
    else add(-10, 'há viés direcional; estrutura neutra desperdiça a leitura');
  }

  const vegaSign = Math.sign(a.greeks.vega);
  if (vol.label === 'cara') vegaSign < 0 ? add(12, 'VI cara: estrutura vendida em volatilidade') : add(-12, 'VI cara: comprar volatilidade cara reduz a vantagem');
  if (vol.label === 'barata') vegaSign > 0 ? add(12, 'VI barata: estrutura comprada em volatilidade') : add(-10, 'VI barata: vender volatilidade barata paga pouco pelo risco');
  if (a.greeks.theta > 0 && vol.label !== 'barata') add(4, 'theta positivo: o tempo trabalha a favor');
  if (vol.ratio != null && vol.ratio < 0.8 && vegaSign < 0) add(-10, `VI ${(vol.ratio * 100).toFixed(0)}% da vol. realizada: vender prêmio paga menos que o movimento atual`);
  if (vol.ratio != null && vol.ratio < 0.8 && vegaSign > 0) add(5, 'VI abaixo da vol. realizada: opção barata frente ao movimento atual');
  const ext = stretch(ctx);
  if (ext && directional && Math.sign(dir.bias) === ext.dir) {
    if (a.family === 'direcional-debito') add(-8, `${ext.msg}: compra a seco no fim do movimento tem risco alto de repique`);
    if (a.family === 'trava-debito') add(3, `${ext.msg}: trava reduz o custo se houver repique`);
  }

  if (!a.debit) {
    if (a.pop >= 0.65) add(6, `probabilidade de lucro ${(a.pop * 100).toFixed(0)}%`);
    else if (a.pop < 0.55) add(-10, `probabilidade de lucro baixa para estrutura de crédito (${(a.pop * 100).toFixed(0)}%)`);
    if (a.widthCredit && -a.cost / a.widthCredit < 0.25) add(-10, 'crédito menor que 25% da largura: risco/retorno ruim');
  } else if (a.rr != null) {
    if (a.rr >= 2) add(6, `retorno/risco ${a.rr.toFixed(1)}x`);
    else if (a.rr < 1.2 && Number.isFinite(a.maxProfit)) add(-10, `retorno/risco baixo (${a.rr.toFixed(1)}x)`);
  }
  if (a.beVsExpMove != null && a.debit) {
    if (a.beVsExpMove > 1) add(-10, 'ponto de equilíbrio além do movimento esperado pela VI');
    else if (a.beVsExpMove < 0.5) add(5, 'ponto de equilíbrio próximo: exige pouco movimento');
  }
  if (a.evSys > 0) add(4, 'expectativa positiva no cenário do sistema');
  else add(-4, 'expectativa negativa no cenário do sistema');
  if (ctx.events && ctx.events.length && !a.debit) add(-5, `${ctx.events.length} evento(s) de alto impacto antes do vencimento (risco de gap)`);
  const spreads = a.legs.map((l) => l.spreadPct).filter((x) => x != null);
  if (spreads.length && Math.max(...spreads) > 10) add(-10, 'spread de compra/venda largo (custo de execução)');
  return { score: Math.round(clamp(s, 0, 100)), why };
}

// Movimento esticado: IFR extremo e preço a mais de 2 ATR da MME20 no sentido do viés.
function stretch(ctx) {
  const t = ctx.ta;
  if (!t || !t.atr || !t.ma || !t.ma.e20 || t.rsi == null) return null;
  const dist = (t.price - t.ma.e20) / t.atr;
  if (t.rsi < 30 && dist < -2) return { dir: -1, msg: `sobrevendido (IFR ${t.rsi.toFixed(0)}, ${Math.abs(dist).toFixed(1)} ATR abaixo da MME20)` };
  if (t.rsi > 70 && dist > 2) return { dir: 1, msg: `sobrecomprado (IFR ${t.rsi.toFixed(0)}, ${dist.toFixed(1)} ATR acima da MME20)` };
  return null;
}

// ---------------- Orquestração ----------------
function generate(ctx, chain) {
  const dir = directionalView(ctx);
  const vol = volView(ctx, chain);
  const ctxChecks = contextGuards(ctx, dir, vol, chain);
  const raw = buildCandidates(ctx, chain, dir);
  const analyzed = raw.map((c) => analyzeCandidate(c, ctx, dir, vol)).map((a) => {
    const sc = scoreCandidate(a, dir, vol, ctx);
    const guard = runGuards(a, ctx, dir, vol, chain);
    return { ...a, score: sc.score, scoreWhy: sc.why, guard };
  });
  const approved = analyzed.filter((a) => !a.guard.blocked).sort((x, y) => y.score - x.score);
  const rejected = analyzed.filter((a) => a.guard.blocked).sort((x, y) => y.score - x.score);
  const globalBlock = ctxChecks.filter((c) => c.status === 'block');
  const best = approved[0] || null;
  let decision = 'OPERAR';
  const reasons = [];
  if (globalBlock.length) { decision = 'NÃO OPERAR'; reasons.push(...globalBlock.map((c) => c.detail)); }
  if (!best) { decision = 'NÃO OPERAR'; reasons.push('Nenhuma estrutura passou pela camada anti-erro.'); }
  else if (best.score < 58) { decision = 'NÃO OPERAR'; reasons.push(`Melhor estrutura com nota ${best.score}/100 (mínimo exigido: 58).`); }
  if (dir.confidence < 35 && best && !['neutra-credito', 'calendario'].includes(best.family)) { decision = 'NÃO OPERAR'; reasons.push(`Confiança direcional baixa (${dir.confidence}/100).`); }
  const ext = stretch(ctx);
  if (ext) ctxChecks.push({ id: 'stretch', group: 'Mercado', label: 'Movimento esticado', status: 'warn', detail: `Ativo ${ext.msg}. Prefira entrada escalonada (metade agora, metade num repique) ou trava.` });
  if (decision === 'OPERAR' && !chain.real) { decision = 'OPERAR — CONFIRMAR NO BOOK'; reasons.push('Preços teóricos: confirme série, prêmio e liquidez reais antes de enviar a ordem.'); }
  return { dir, vol, contextChecks: ctxChecks, decision, reasons, best, alternatives: approved.slice(1, 4), rejected };
}

module.exports = { generate, directionalView, volView };
