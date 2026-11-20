'use strict';
// Motor de estratégias (v2).
//
// 1) VIÉS: gráfico e macro entram pelo que REALMENTE aconteceu neste ativo (escore-z do retorno
//    excedente nos últimos ~5 anos), não por suposição. Antecedentes (ADR/commodity) e notícias
//    entram com peso pequeno. Confiança = força estatística combinada (Stouffer).
// 2) VOLATILIDADE: VI vs volatilidade PREVISTA (EWMA convergindo para a média de longo prazo).
//    Vantagem de vol. só é contada quando a VI é real (grade real ou VXEWZ para o EWZ).
// 3) CANDIDATAS: menu completo (alta, baixa e neutras), sempre.
// 4) EXPECTATIVA: cada estrutura é precificada pela VI (mercado) e avaliada sob a distribuição
//    "real" (vol. prevista + drift calibrado com encolhimento bayesiano). Ranking por
//    expectativa/risco + aderência ao cenário, depois a camada anti-erro.
// 5) DECISÃO EM NÍVEIS: OPERAR · OPERAR COM TAMANHO REDUZIDO ·
//    NÃO VALE A PENA — MAS SE QUISER, O MAIS INDICADO É… (estrutura de menor dano esperado,
//    risco definido, tamanho reduzido), com gatilhos do que mudaria a decisão.
const bs = require('./bs');
const { runGuards, contextGuards } = require('./guards');

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const NEUTRAL_FAMS = ['neutra-credito', 'neutra-debito', 'calendario'];

// ---------------- Volatilidade prevista ----------------
// Variância média esperada até o horizonte: converge da EWMA para a vol. de longo prazo
// com meia-vida de 20 pregões (estrutura de termo tipo GARCH, sem estimar parâmetros frágeis).
function physVol(ta, calendarDays) {
  const lr = ta.hv252 || ta.hv60 || ta.hv20;
  const now = ta.ewma || ta.hv20 || lr;
  if (!lr || !now) return null;
  const h = Math.max(1, (calendarDays * 252) / 365);
  const k = Math.LN2 / 20;
  const w = (1 - Math.exp(-k * h)) / (k * h);
  return Math.sqrt(lr * lr + (now * now - lr * lr) * w);
}

// ---------------- Viés direcional ----------------
function directionalView(ctx) {
  const { ta, regime, lead, newsTag } = ctx;
  const comps = [];
  const zs = [];
  const tb = ctx.techAudit && ctx.techAudit.bucket;
  if (tb && tb.n >= 25 && tb.nEff >= 6 && Number.isFinite(tb.zMean)) {
    comps.push({ id: 'tech', label: `Gráfico — faixa "${tb.label}" (histórico)`, score: clamp(tb.zMean * 30, -100, 100), w: 0.42, z: tb.zMean, raw: ta.score });
    zs.push(tb.zMean);
  } else {
    comps.push({ id: 'tech', label: 'Gráfico (sem histórico conclusivo)', score: ta.score * 0.35, w: 0.42, z: null, raw: ta.score });
  }
  const mb = ctx.macroAudit && ctx.macroAudit.bucket;
  if (mb && mb.n >= 25 && mb.nEff >= 6 && Number.isFinite(mb.zMean)) {
    comps.push({ id: 'macro', label: `Macro — regime "${mb.label}" (histórico)`, score: clamp(mb.zMean * 30, -100, 100), w: 0.42, z: mb.zMean, raw: regime.score });
    zs.push(mb.zMean);
  } else {
    comps.push({ id: 'macro', label: 'Macro (sem calibração)', score: 0, w: 0.2, z: null, raw: regime.score });
  }
  if (lead && Number.isFinite(lead.score)) comps.push({ id: 'lead', label: lead.label, score: lead.score, w: 0.1 });
  if (newsTag && newsTag.n >= 3) comps.push({ id: 'news', label: `Notícias (${newsTag.n} manchetes)`, score: clamp((newsTag.s / newsTag.n) * 40, -100, 100), w: 0.06 });
  const wsum = comps.reduce((a, c) => a + c.w, 0);
  const bias = comps.reduce((a, c) => a + c.score * c.w, 0) / wsum;

  // Confiança estatística: Stouffer dos escores-z calibrados.
  const zc = zs.length ? zs.reduce((a, b) => a + b, 0) / Math.sqrt(zs.length) : 0;
  let confidence = (2 * bs.normCdf(Math.abs(zc) / 1.5) - 1) * 100;
  confidence *= clamp((regime.quorum || 0) / 100, 0.5, 1) * (regime.stress ? 0.85 : 1);
  if (lead && Math.abs(lead.score) >= 30 && Math.sign(lead.score) === Math.sign(bias)) confidence += 4;
  confidence = Math.round(clamp(confidence, 0, 100));

  let label = 'neutra';
  if (bias >= 12) label = bias >= 35 ? 'altista forte' : 'altista';
  else if (bias <= -12) label = bias <= -35 ? 'baixista forte' : 'baixista';
  const zt = comps[0].z, zm = comps[1].z;
  const conflict = zt != null && zm != null && Math.abs(zt) >= 1 && Math.abs(zm) >= 1 && Math.sign(zt) !== Math.sign(zm);

  // Retorno esperado (10 pregões) para o cenário calibrado. As duas auditorias usam o MESMO
  // histórico do ativo, então não somam informação independente: média ponderada e peso de
  // encolhimento pela amostra média. Prior (peso restante) = forward risco-neutro do mercado.
  const parts = [tb, mb].filter((b) => b && b.n >= 25 && b.nEff >= 6 && Number.isFinite(b.avgFwd));
  const nBar = parts.length ? parts.reduce((a, b) => a + b.nEff, 0) / parts.length : 0;
  const drift10 = parts.length ? parts.reduce((a, b) => a + b.avgFwd * b.nEff, 0) / parts.reduce((a, b) => a + b.nEff, 0) : 0;
  const driftW = parts.length ? nBar / (nBar + 25) : 0;

  return { bias: Math.round(bias), label, confidence, zCombined: zc, comps, conflict, drift10, driftW, techAudit: ctx.techAudit, macroAudit: ctx.macroAudit };
}

// ---------------- Volatilidade ----------------
function volView(ctx, chain) {
  const { ta } = ctx;
  const exp = pickExpiry(chain, 25, 60, 40);
  let atmIv = null;
  if (exp) {
    const atm = exp.options.filter((o) => o.iv).sort((a, b) => Math.abs(a.strike - ctx.S) - Math.abs(b.strike - ctx.S)).slice(0, 4);
    if (atm.length) atmIv = atm.reduce((a, o) => a + o.iv, 0) / atm.length;
  }
  const fc = physVol(ta, exp ? exp.dte : 40);
  const ratio = atmIv && fc ? atmIv / fc : null;
  const ivRank = ctx.ivHistory ? ctx.ivHistory.rank : null;
  const ivReal = Boolean(ctx.ivReal);
  let label = 'justa';
  if (!ivReal) label = 'estimada';
  else if ((ratio && ratio > 1.2) || (ivRank != null && ivRank > 70)) label = 'cara';
  else if (ratio && ratio < 0.85 && (ivRank == null || ivRank < 40)) label = 'barata';
  return { atmIv, forecast: fc, hv20: ta.hv20, ewma: ta.ewma, hv252: ta.hv252, hvPct: ta.hvPct, ratio, ivRank, ivReal, label, expiry: exp ? exp.date : null, theoretical: !chain.real };
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
const leg = (o, side) => ({ ...o, side });

// ---------------- Candidatas (menu completo) ----------------
function buildCandidates(ctx, chain) {
  const S = ctx.S;
  const out = [];
  // Largura das travas: ~4% do preço, estreitada para caber no risco máximo por operação
  // (ativos caros/EUA: 1 contrato de trava larga pode passar do limite).
  const fx = ctx.market === 'US' ? ctx.usdbrl || 5.5 : 1;
  const budgetPerShare = (ctx.capital * ctx.maxRiskPct) / 100 / (100 * fx);
  const width = () => {
    const step = ctx.strikeStep;
    const ideal = Math.round((S * 0.04) / step) * step;
    const fit = Math.floor((2 * budgetPerShare) / step) * step;
    return Math.max(step, Math.min(ideal, fit || step));
  };
  const e1 = pickExpiry(chain, 28, 75, 45);
  const e2 = pickExpiry(chain, 21, 50, 35);
  const front = pickExpiry(chain, 18, 40, 28);
  const back = pickExpiry(chain, 55, 120, 75);
  for (const intent of [1, -1]) {
    const bull = intent > 0;
    const t = bull ? 'call' : 'put';
    if (e1) {
      const o = byDelta(e1, t, 0.45);
      if (o) out.push({ key: `long_${t}`, intent, name: bull ? 'Compra de call' : 'Compra de put', family: 'direcional-debito', legs: [leg(o, 1)] });
      const l = byDelta(e1, t, 0.5);
      if (l) {
        const s = byStrike(e1, t, bull ? l.strike + width() : l.strike - width());
        if (s && s.strike !== l.strike) out.push({ key: `debit_${t}`, intent, name: bull ? 'Trava de alta com calls (débito)' : 'Trava de baixa com puts (débito)', family: 'trava-debito', legs: [leg(l, 1), leg(s, -1)] });
      }
    }
    if (e2) {
      const ct = bull ? 'put' : 'call';
      const s = byDelta(e2, ct, 0.28);
      if (s) {
        const l = byStrike(e2, ct, bull ? s.strike - width() : s.strike + width());
        if (l && l.strike !== s.strike) out.push({ key: `credit_${ct}`, intent, name: bull ? 'Trava de alta com puts (crédito)' : 'Trava de baixa com calls (crédito)', family: 'trava-credito', legs: [leg(s, -1), leg(l, 1)] });
        if (bull) out.push({ key: 'short_put', intent, name: 'Venda de put coberta por caixa', family: 'venda-coberta', legs: [leg(s, -1)] });
      }
    }
    if (front && back && back.date !== front.date) {
      const l = byDelta(back, t, 0.6);
      const s = l && byDelta(front, t, 0.3, (o) => (bull ? o.strike > l.strike : o.strike < l.strike));
      if (l && s) out.push({ key: `diag_${t}`, intent, name: bull ? 'Diagonal de alta com calls' : 'Diagonal de baixa com puts', family: 'diagonal', legs: [leg(l, 1), leg(s, -1)] });
    }
  }
  const e = pickExpiry(chain, 25, 55, 38);
  if (e) {
    const sp = byDelta(e, 'put', 0.18), sc = byDelta(e, 'call', 0.18);
    if (sp && sc) {
      const lp = byStrike(e, 'put', sp.strike - width()), lc = byStrike(e, 'call', sc.strike + width());
      if (lp && lc && lp.strike < sp.strike && lc.strike > sc.strike) out.push({ key: 'condor', intent: 0, name: 'Iron condor (venda de volatilidade, risco definido)', family: 'neutra-credito', legs: [leg(lp, 1), leg(sp, -1), leg(sc, -1), leg(lc, 1)] });
    }
    const ac = byDelta(e, 'call', 0.5), ap = byDelta(e, 'put', 0.5);
    if (ac && ap) out.push({ key: 'straddle', intent: 0, name: 'Compra de straddle (aposta em movimento forte)', family: 'neutra-debito', legs: [leg(ac, 1), leg(ap, 1)] });
  }
  if (front && back && front.date !== back.date) {
    const s = byDelta(front, 'call', 0.5);
    const l = s && byStrike(back, 'call', s.strike);
    if (s && l) out.push({ key: 'calendar', intent: 0, name: 'Calendário com calls (ATM)', family: 'calendario', legs: [leg(l, 1), leg(s, -1)] });
  }
  return out;
}

// ---------------- Métricas ----------------
function analyzeCandidate(c, ctx, dir, vol) {
  const S = ctx.S;
  const lot = 100; // contrato EUA = 100 ações; lote padrão B3 = 100 opções
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
  const callNet = c.legs.filter((l) => l.type === 'call').reduce((a, l) => a + l.side, 0);
  const unlimitedLoss = callNet < 0;
  const unlimitedGain = callNet > 0 && grid[N].exp - grid[N - 1].exp > 1e-6;
  if (c.key === 'short_put') maxL = Math.min(maxL, pnlAt(0.0001, horizon));
  const bes = [];
  for (let i = 1; i <= N; i++) if (Math.sign(grid[i].exp) !== Math.sign(grid[i - 1].exp) && grid[i - 1].exp !== 0) bes.push(+(grid[i - 1].s + ((grid[i].s - grid[i - 1].s) * -grid[i - 1].exp) / (grid[i].exp - grid[i - 1].exp)).toFixed(2));

  const sigmaMkt = vol.atmIv || ctx.ivFallback;
  const T = horizon / 365;
  // Medida de mercado (risco-neutra, VI)
  const rn = bs.lognormalGrid(S, T, sigmaMkt, ctx.r - ctx.q);
  const pop = rn.reduce((a, p) => a + (pnlAt(p.s, horizon) > 0 ? p.w : 0), 0);
  // Medida "real": vol. prevista (se VI real) + drift calibrado
  const sigmaPhys = vol.ivReal && vol.forecast ? physVol(ctx.ta, horizon) || sigmaMkt : sigmaMkt;
  // Média do log-preço no horizonte: w × histórico calibrado + (1−w) × forward risco-neutro.
  const tradingDays = (horizon * 252) / 365;
  const histLog = Math.log(1 + (dir.drift10 / 100) * (tradingDays / (ctx.calibHorizon || 10)));
  const rnLog = (ctx.r - ctx.q) * T;
  let tilt = dir.driftW * histLog + (1 - dir.driftW) * rnLog;
  tilt = clamp(tilt, rnLog - 0.5 * sigmaPhys * Math.sqrt(T), rnLog + 0.5 * sigmaPhys * Math.sqrt(T));
  const ph = bs.lognormalGrid(S * Math.exp(tilt), T, sigmaPhys, 0);
  const evPhys = ph.reduce((a, p) => a + pnlAt(p.s, horizon) * p.w, 0);
  const sdPhys = Math.sqrt(ph.reduce((a, p) => a + (pnlAt(p.s, horizon) - evPhys) ** 2 * p.w, 0));
  const sharpe = sdPhys > 0 ? evPhys / sdPhys : 0; // ganho esperado por unidade de incerteza
  const popPhys = ph.reduce((a, p) => a + (pnlAt(p.s, horizon) > 0 ? p.w : 0), 0);
  // Pior cenário plausível: percentil 5% da distribuição real
  const sorted = ph.map((p) => ({ v: pnlAt(p.s, horizon), w: p.w })).sort((a, b) => a.v - b.v);
  let acc = 0, var5 = sorted[0].v;
  for (const x of sorted) { acc += x.w; if (acc >= 0.05) { var5 = x.v; break; } }

  const g = c.legs.reduce((a, l) => ({
    delta: a.delta + l.side * (l.delta || 0),
    gamma: a.gamma + l.side * (l.gamma || 0),
    theta: a.theta + l.side * (l.theta || 0),
    vega: a.vega + l.side * (l.vega || 0),
  }), { delta: 0, gamma: 0, theta: 0, vega: 0 });

  const expMove = S * sigmaMkt * Math.sqrt(T);
  const nearestBe = bes.length ? bes.reduce((a, b) => (Math.abs(b - S) < Math.abs(a - S) ? b : a)) : null;
  const beMove = nearestBe ? Math.abs(nearestBe - S) : null;
  const maxLossAbs = unlimitedLoss ? Infinity : Math.abs(Math.min(0, maxL));
  const rr = maxLossAbs && Number.isFinite(maxLossAbs) && maxLossAbs > 0 ? maxP / maxLossAbs : null;
  const ror = Number.isFinite(maxLossAbs) && maxLossAbs > 0 ? evPhys / maxLossAbs : -Infinity;
  const widthCredit = c.family === 'trava-credito' ? Math.abs(c.legs[0].strike - c.legs[1].strike) : null;

  const fx = ctx.market === 'US' ? ctx.usdbrl || 5.5 : 1;
  const maxRiskBRL = (ctx.capital * ctx.maxRiskPct) / 100;
  let riskPerLot = maxLossAbs * lot * fx;
  if (c.key === 'short_put') riskPerLot = c.legs[0].strike * lot * fx;
  const lots = Number.isFinite(riskPerLot) && riskPerLot > 0 ? Math.floor((c.key === 'short_put' ? ctx.capital * 0.25 : maxRiskBRL) / riskPerLot) : 0;
  const payoff = grid.filter((_, i) => i % 3 === 0).map((p) => ({ s: +p.s.toFixed(2), exp: +(p.exp * lot).toFixed(2), now: +(p.now * lot).toFixed(2) }));

  return {
    ...c, horizon: Math.round(horizon), cost, debit: cost > 0,
    maxProfit: unlimitedGain ? Infinity : maxP, maxLoss: unlimitedLoss ? -Infinity : maxL,
    unlimitedLoss, unlimitedGain, breakevens: bes,
    pop, popPhys, evPhys, sdPhys, sharpe, ror, var5, sigmaPhys, tilt,
    rr, widthCredit, greeks: g, expMove, beMove, beVsExpMove: beMove != null && expMove ? beMove / expMove : null,
    lot, fx, riskPerLot, lots, maxRiskBRL, payoff,
  };
}

// ---------------- Pontuação ----------------
function scoreCandidate(a, dir, vol, ctx) {
  let s = 50;
  const why = [];
  const add = (v, msg) => { if (v) { s += v; why.push({ v: Math.round(v), msg }); } };
  const pct = (x) => `${(x * 100).toFixed(1)}%`;

  // 1) Vantagem matemática: expectativa calibrada em relação ao risco máximo
  add(clamp(a.sharpe * 90, -25, 25), `ganho esperado ${a.evPhys >= 0 ? 'positivo' : 'negativo'} ajustado à dispersão (índice ${a.sharpe.toFixed(2)}; ${a.ror >= 0 ? '+' : ''}${Number.isFinite(a.ror) ? pct(a.ror) : '—'} do risco máximo)`);

  // 2) Aderência ao viés
  const conf = dir.confidence;
  if (a.intent !== 0) {
    if (Math.abs(dir.bias) >= 12) {
      if (a.intent === Math.sign(dir.bias)) add(8 * Math.min(1, conf / 50 + 0.3), `alinhada ao viés ${dir.label}`);
      else add(-12, `contra o viés ${dir.label}`);
    } else add(-6, 'sem direção clara para estrutura direcional');
  } else if (Math.abs(dir.bias) < 15) add(6, 'cenário sem direção favorece estrutura neutra');
  else add(-4, 'há viés direcional; estrutura neutra não o aproveita');

  // 3) Volatilidade (só com VI real)
  const vegaSign = Math.sign(a.greeks.vega);
  if (vol.ivReal) {
    if (vol.label === 'cara') vegaSign < 0 ? add(10, 'VI cara frente à vol. prevista: vender prêmio') : add(-10, 'VI cara: comprar opção cara');
    if (vol.label === 'barata') vegaSign > 0 ? add(10, 'VI barata frente à vol. prevista: comprar opção') : add(-10, 'VI barata: vender prêmio paga pouco pelo risco');
  }
  if (a.greeks.theta > 0 && vol.label !== 'barata') add(3, 'theta positivo: o tempo trabalha a favor');

  // 4) Qualidade da estrutura
  if (!a.debit) {
    if (a.pop >= 0.65) add(5, `probabilidade de lucro ${(a.pop * 100).toFixed(0)}%`);
    else if (a.pop < 0.55) add(-8, `probabilidade de lucro baixa para crédito (${(a.pop * 100).toFixed(0)}%)`);
    if (a.widthCredit && -a.cost / a.widthCredit < 0.25) add(-8, 'crédito menor que 25% da largura');
  } else if (a.rr != null && Number.isFinite(a.maxProfit)) {
    if (a.rr >= 2) add(5, `retorno/risco ${a.rr.toFixed(1)}x`);
    else if (a.rr < 1.2) add(-8, `retorno/risco baixo (${a.rr.toFixed(1)}x)`);
  }
  if (a.beVsExpMove != null && a.debit && a.family !== 'neutra-debito') {
    if (a.beVsExpMove > 1) add(-8, 'equilíbrio além do movimento esperado');
    else if (a.beVsExpMove < 0.5) add(4, 'equilíbrio próximo');
  }
  const ext = stretch(ctx);
  if (ext && a.intent === ext.dir) {
    if (a.family === 'direcional-debito') add(-8, `${ext.msg}: compra a seco no fim do movimento`);
    if (a.family === 'trava-debito') add(3, `${ext.msg}: trava amortece o repique`);
  }
  if (ctx.events && ctx.events.length && !a.debit) add(-4, `${ctx.events.length} evento(s) de alto impacto antes do vencimento`);
  const spreads = a.legs.map((l) => l.spreadPct).filter((x) => x != null);
  if (spreads.length && Math.max(...spreads) > 10) add(-10, 'spread de compra/venda largo');
  return { score: Math.round(clamp(s, 0, 100)), why };
}

function stretch(ctx) {
  const t = ctx.ta;
  if (!t || !t.atr || !t.ma || !t.ma.e20 || t.rsi == null) return null;
  const dist = (t.price - t.ma.e20) / t.atr;
  if (t.rsi < 30 && dist < -2) return { dir: -1, msg: `sobrevendido (IFR ${t.rsi.toFixed(0)}, ${Math.abs(dist).toFixed(1)} ATR abaixo da MME20)` };
  if (t.rsi > 70 && dist > 2) return { dir: 1, msg: `sobrecomprado (IFR ${t.rsi.toFixed(0)}, ${dist.toFixed(1)} ATR acima da MME20)` };
  return null;
}

// ---------------- Gatilhos: o que mudaria a decisão ----------------
function triggers(ctx, dir, vol) {
  const out = [];
  const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '—');
  const ta = ctx.ta;
  const tc = ctx.techCalib;
  if (tc && tc.ok) {
    const cur = dir.techAudit && dir.techAudit.bucket ? dir.techAudit.bucket.id : null;
    for (const b of tc.buckets) {
      if (b.id === cur || !(b.n >= 25) || !(b.nEff >= 6) || !Number.isFinite(b.zMean) || Math.abs(b.zMean) < 1) continue;
      out.push({ kind: 'grafico', text: `Se o gráfico entrar na faixa "${b.label}", o histórico deste ativo favorece ${b.zMean > 0 ? 'ALTA' : 'QUEDA'} (retorno médio ${b.avgFwd >= 0 ? '+' : ''}${b.avgFwd.toFixed(2)}% em ${tc.horizon} pregões; z=${b.zMean.toFixed(1)}).` });
    }
  }
  const mc = ctx.macroCalib;
  if (mc && mc.ok) {
    const cur = dir.macroAudit && dir.macroAudit.bucket ? dir.macroAudit.bucket.id : null;
    for (const b of mc.buckets) {
      if (b.id === cur || !(b.n >= 25) || !(b.nEff >= 6) || Math.abs(b.zMean) < 1) continue;
      out.push({ kind: 'macro', text: `Se o regime de mercado virar "${b.label}", o histórico deste ativo favorece ${b.zMean > 0 ? 'ALTA' : 'QUEDA'} (${b.avgFwd >= 0 ? '+' : ''}${b.avgFwd.toFixed(2)}% em ${mc.horizon} pregões; z=${b.zMean.toFixed(1)}).` });
    }
  }
  if (ta && ta.ma) {
    const s1 = ta.supports[0], r1 = ta.resistances[0];
    out.push({ kind: 'preco', text: `Níveis que mudam a leitura técnica: fechamento ${ta.price > ta.ma.e20 ? 'abaixo' : 'acima'} da MME20 (${f2(ta.ma.e20)})${s1 ? `, perda do suporte ${f2(s1.price)}` : ''}${r1 ? `, rompimento da resistência ${f2(r1.price)}` : ''}.` });
  }
  if (vol.ivReal && vol.forecast) {
    out.push({ kind: 'vol', text: `VI acima de ${(vol.forecast * 120).toFixed(0)}% (20% sobre a vol. prevista) favorece VENDER prêmio; abaixo de ${(vol.forecast * 85).toFixed(0)}% favorece COMPRAR opções. Hoje: ${(vol.atmIv * 100).toFixed(1)}%.` });
  } else {
    out.push({ kind: 'vol', text: 'Com a grade real de opções (Tradier/OpLab) o sistema passa a medir se a opção está cara ou barata — hoje a VI é estimada.' });
  }
  const ev = (ctx.eventsAll || []).find((e) => e.impact >= 3 && e.daysAway >= 0);
  if (ev) out.push({ kind: 'evento', text: `Depois de ${ev.title} (${ev.date.split('-').reverse().join('/')}, em ${ev.daysAway} dia(s)) a volatilidade é reprecificada: reavalie.` });
  return out.slice(0, 6);
}

// ---------------- Orquestração ----------------
function generate(ctx, chain) {
  const dir = directionalView(ctx);
  const vol = volView(ctx, chain);
  const ctxChecks = contextGuards(ctx, dir, vol, chain);
  const analyzed = buildCandidates(ctx, chain).map((c) => analyzeCandidate(c, ctx, dir, vol)).map((a) => {
    const sc = scoreCandidate(a, dir, vol, ctx);
    const guard = runGuards(a, ctx, dir, vol, chain);
    return { ...a, score: sc.score, scoreWhy: sc.why, guard };
  });
  const approved = analyzed.filter((a) => !a.guard.blocked).sort((x, y) => y.score - x.score);
  const rejected = analyzed.filter((a) => a.guard.blocked).sort((x, y) => y.score - x.score);
  const globalBlock = ctxChecks.filter((c) => c.status === 'block');
  const ext = stretch(ctx);
  if (ext) ctxChecks.push({ id: 'stretch', group: 'Mercado', label: 'Movimento esticado', status: 'warn', detail: `Ativo ${ext.msg}. Prefira entrada escalonada ou trava.` });

  // Melhor = maior nota entre as de ganho esperado POSITIVO; só sem nenhuma positiva usa a maior nota geral.
  // Vantagem MATERIAL: ganho ≥ 5% do risco e ganho/dispersão ≥ 0,04 (abaixo disso é ruído do modelo).
  // Estruturas neutras de volatilidade só contam com VI real (sem ela a vantagem não é mensurável).
  const material = (a) => a.evPhys > 0 && a.ror >= 0.05 && a.sharpe >= 0.04 && (vol.ivReal || a.intent !== 0);
  const positive = approved.filter(material);
  const best = positive[0] || approved[0] || null;
  const notWorth = [];
  const plain = [];
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const money = (x) => `R$ ${Math.abs(x).toFixed(0)}`;

  // Leitura em linguagem direta
  const ta = dir.techAudit, ma = dir.macroAudit;
  if (ta && ta.bucket && ta.status !== 'unknown') plain.push(`Gráfico: ${ta.short || ta.msg}`);
  if (ma && ma.bucket && ma.status !== 'unknown') plain.push(`Macro: ${ma.short || ma.msg}`);
  if (ctx.regime.stress) plain.push(`Mercado em estresse (VIX ${ctx.vix ? ctx.vix.toFixed(0) : '≥30'}): gaps grandes são prováveis — só risco definido.`);
  if (!vol.ivReal) plain.push('Volatilidade implícita estimada: a vantagem de comprar/vender volatilidade não pode ser medida sem a grade real.');
  else plain.push(`Opções ${vol.label === 'cara' ? 'CARAS' : vol.label === 'barata' ? 'BARATAS' : 'em preço justo'}: VI ${(vol.atmIv * 100).toFixed(1)}% vs vol. prevista ${(vol.forecast * 100).toFixed(1)}%.`);

  let level, label, role, shown = best, sizeFactor = 1;
  if (globalBlock.length || !best) {
    level = 'bloqueado';
    label = 'NÃO OPERAR';
    role = null;
    shown = null;
    if (globalBlock.length) notWorth.push(...globalBlock.map((c) => c.detail));
    if (!best) {
      const sizeOnly = rejected.length && rejected.every((r) => r.guard.checks.some((c) => c.id === 'size' && c.status === 'block'));
      if (sizeOnly) {
        const minRisk = Math.min(...rejected.map((r) => r.riskPerLot).filter(Number.isFinite));
        notWorth.push(`Com capital de R$ ${ctx.capital.toLocaleString('pt-BR')} e risco máximo de ${ctx.maxRiskPct}% (R$ ${(ctx.capital * ctx.maxRiskPct / 100).toFixed(0)}), nem 1 lote cabe: a estrutura mais barata arrisca R$ ${minRisk.toFixed(0)}. Aumente o capital ou o risco por operação para ver a análise.`);
      } else notWorth.push('Nenhuma estrutura passou pelos filtros de segurança — nem como alternativa.');
    }
  } else {
    const directional = best.intent !== 0;
    if (!material(best)) notWorth.push(best.evPhys > 0
      ? `Nenhuma estrutura tem vantagem material: a melhor ganha ${Number.isFinite(best.ror) ? pct(best.ror) : '—'} do risco em média${!vol.ivReal && best.intent === 0 ? ', e é aposta em volatilidade sem VI de mercado para medir' : ' — dentro da margem de erro do modelo'}.`
      : `Nenhuma estrutura tem ganho esperado positivo pelo comportamento histórico do ativo.`);
    if (directional && dir.confidence < 30) notWorth.push(`Evidência histórica fraca para a direção (confiança ${dir.confidence}/100).`);
    if (best.score < 58) notWorth.push(`Melhor nota ${best.score}/100 (mínimo 58).`);
    if (dir.conflict) notWorth.push('Gráfico e macro apontam, historicamente, para lados opostos.');

    if (!notWorth.length) {
      const strong = best.score >= 68 && (!directional || dir.confidence >= 40) && !ctx.regime.stress;
      level = strong ? 'operar' : 'reduzido';
      label = strong ? 'OPERAR' : 'OPERAR COM TAMANHO REDUZIDO';
      role = strong ? 'Operação recomendada' : 'Operação recomendada — metade do tamanho';
      sizeFactor = strong ? 1 : 0.5;
      if (!strong) {
        if (ctx.regime.stress) notWorth.push('Regime de estresse: tamanho pela metade.');
        if (directional && dir.confidence < 40) notWorth.push(`Confiança moderada (${dir.confidence}/100): tamanho pela metade.`);
        if (best.score < 68) notWorth.push(`Nota ${best.score}/100: vantagem existe, mas é modesta.`);
      }
    } else {
      level = 'nao_vale';
      // Alternativa: melhor ganho esperado por unidade de incerteza (menor dano), risco definido, sem venda coberta
      const pool = approved.filter((a) => a.key !== 'short_put' && Number.isFinite(a.ror));
      const ranked = (pool.length ? pool : approved).slice().sort((x, y) => (y.sharpe - x.sharpe) || (y.score - x.score));
      // Entre as de ganho/dispersão próximos do melhor (≥ 80%), prefere a de maior probabilidade de lucro.
      const top = ranked[0].sharpe;
      const near = top > 0 ? ranked.filter((x) => x.sharpe >= top * 0.8) : [ranked[0]];
      shown = near.sort((x, y) => y.popPhys - x.popPhys)[0];
      label = 'NÃO VALE A PENA';
      role = 'Mas, se quiser operar, o mais indicado é';
      sizeFactor = 1 / 3;
    }
  }
  if (shown) {
    shown = { ...shown };
    shown.lotsFull = shown.lots;
    shown.lots = shown.lots >= 1 ? Math.max(1, Math.floor(shown.lots * sizeFactor)) : 0;
    shown.sizeFactor = sizeFactor;
  }
  const headline = level === 'nao_vale' ? `NÃO VALE A PENA — MAS, SE QUISER, O MAIS INDICADO É: ${shown.name.toUpperCase()}`
    : level === 'bloqueado' ? 'NÃO OPERAR — nenhuma estrutura segura disponível'
    : `${label}: ${shown.name}`;
  let summary = '';
  if (shown) {
    const ev = shown.evPhys * shown.lot * shown.fx;
    summary = `${shown.name}: ganho esperado ${ev >= 0 ? '+' : '−'}${money(ev)} por lote (${pct(shown.ror)} do risco), probabilidade de lucro ${(shown.popPhys * 100).toFixed(0)}% no cenário calibrado, perda máxima ${money(shown.maxLoss * shown.lot * shown.fx)} por lote.`;
  }
  const decision = { level, label, headline, role, summary, needsBookCheck: !chain.real, sizeFactor };
  const others = approved.filter((a) => !shown || a.key !== shown.key);
  return { dir, vol, contextChecks: ctxChecks, decision, notWorth, plain, triggers: triggers(ctx, dir, vol), best: shown, alternatives: others.slice(0, 5), rejected };
}

module.exports = { generate, directionalView, volView, physVol };
