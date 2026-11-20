'use strict';
// CAMADA ANTI-ERRO
// Toda operação passa por verificações em 4 frentes antes de chegar ao usuário:
//  A) Integridade dos dados   — dado velho, incompleto ou incoerente => bloqueia.
//  B) Coerência dos cálculos  — auto-teste do próprio motor (payoff, sinais, limites de arbitragem).
//  C) Risco de mercado        — risco ilimitado, vencimento curto, liquidez, eventos, estresse.
//  D) Gestão de risco         — tamanho de posição contra o capital e o risco máximo por operação.
// status: 'ok' | 'warn' (alerta, não impede) | 'block' (impede a recomendação).

const check = (id, group, label, status, detail) => ({ id, group, label, status, detail });

function contextGuards(ctx, dir, vol, chain) {
  const out = [];
  const q = ctx.regime.quorum;
  out.push(check('quorum', 'Dados', 'Cobertura dos indicadores macro', q < 50 ? 'block' : q < 75 ? 'warn' : 'ok',
    `${q}% dos indicadores macro disponíveis${ctx.regime.missing.length ? ` (faltando: ${ctx.regime.missing.join(', ')})` : ''}.`));

  if (ctx.marketOpen && ctx.priceAgeMin != null) {
    out.push(check('fresh', 'Dados', 'Atualidade da cotação', ctx.priceAgeMin > 45 ? 'block' : ctx.priceAgeMin > 25 ? 'warn' : 'ok',
      `Cotação com ${Math.round(ctx.priceAgeMin)} min de idade com o mercado aberto.`));
  } else {
    out.push(check('fresh', 'Dados', 'Atualidade da cotação', 'ok', 'Mercado fechado: análise baseada no último fechamento.'));
  }
  const lastClose = ctx.ta && ctx.ta.price;
  if (lastClose && ctx.S) {
    const d = Math.abs(ctx.S / lastClose - 1) * 100;
    out.push(check('sanity-price', 'Dados', 'Consistência do preço do ativo', d > 15 ? 'block' : 'ok',
      d > 15 ? `Cotação diverge ${d.toFixed(1)}% do histórico — possível dado corrompido.` : 'Cotação coerente com o histórico.'));
  }
  if (ctx.historyLen < 200) out.push(check('history', 'Dados', 'Histórico para MMA200', 'warn', `Apenas ${ctx.historyLen} pregões: MMA200 indisponível ou pouco confiável.`));
  out.push(check('vol-data', 'Dados', 'Volatilidade implícita disponível', vol.atmIv ? 'ok' : 'block', vol.atmIv ? `VI ATM ${(vol.atmIv * 100).toFixed(1)}%${vol.theoretical ? ' (estimada)' : ''}.` : 'Sem VI: impossível precificar com segurança.'));
  if (!chain.real) out.push(check('theoretical', 'Dados', 'Fonte de preços das opções', 'warn',
    `Grade TEÓRICA (${chain.volMethod || 'Black-Scholes'}). Strikes e prêmios são estimativas: confirme série, prêmio e liquidez no book antes de enviar ordem.`));
  if (chain.unvalidated) out.push(check('connector', 'Dados', 'Conector de dados', 'warn', 'Conector OpLab ainda não validado com dados reais: confira os números com a plataforma.'));

  out.push(check('conflict', 'Mercado', 'Técnico x macro', dir.conflict ? 'block' : 'ok',
    dir.conflict ? `Sinais fortes e opostos: técnico ${ctx.ta.score > 0 ? '+' : ''}${ctx.ta.score} contra macro ${ctx.regime.score > 0 ? '+' : ''}${ctx.regime.score}. Ficar de fora é a decisão profissional.` : 'Sem conflito forte entre gráfico e macro.'));
  if (ctx.regime.stress) out.push(check('stress', 'Mercado', 'Regime de estresse', 'warn', 'VIX ≥ 30 ou VXEWZ ≥ 45: apenas estruturas de risco definido são permitidas; gaps prováveis.'));
  if (ctx.lead && ctx.lead.adrPost && Math.abs(ctx.lead.adrPost) >= 2) out.push(check('gap', 'Mercado', 'Gap esperado na abertura', 'warn', `ADR/EWZ moveu ${ctx.lead.adrPost.toFixed(1)}% no after-market: a abertura deve ter gap; não envie ordem a mercado no leilão.`));
  const soon = (ctx.eventsAll || []).filter((e) => e.daysAway <= 2 && e.impact >= 3);
  if (soon.length) out.push(check('event-soon', 'Mercado', 'Evento de alto impacto iminente', 'warn', soon.map((e) => `${e.title} (${e.date})`).join('; ')));
  return out;
}

function runGuards(a, ctx, dir, vol, chain) {
  const c = [];
  const fam = a.family;
  const isDebit = a.debit;

  // ---------- B) Coerência dos cálculos (auto-teste) ----------
  const legsOk = a.legs.every((l) => l.mid > 0 && Number.isFinite(l.mid) && l.strike > 0);
  c.push(check('calc-legs', 'Cálculo', 'Pernas com preço válido', legsOk ? 'ok' : 'block', legsOk ? 'Todas as pernas têm prêmio positivo.' : 'Alguma perna sem prêmio válido.'));
  if (isDebit && Number.isFinite(a.maxLoss)) {
    const okLoss = a.maxLoss <= 1e-9 && Math.abs(-a.maxLoss - a.cost) <= Math.max(0.02, a.cost * 0.08) || ['diagonal', 'calendario'].includes(fam);
    c.push(check('calc-maxloss', 'Cálculo', 'Perda máxima = prêmio pago', okLoss ? 'ok' : 'block', okLoss ? 'Perda máxima coerente com o débito.' : 'Inconsistência: perda máxima diferente do débito — cálculo descartado.'));
  }
  if (fam === 'trava-debito' || fam === 'trava-credito') {
    const w = Math.abs(a.legs[0].strike - a.legs[1].strike);
    const okW = a.maxProfit <= w + 1e-6 && Math.abs(a.maxLoss) <= w + 1e-6;
    c.push(check('calc-width', 'Cálculo', 'Limites da trava respeitam a largura', okW ? 'ok' : 'block', okW ? `Ganho e perda limitados à largura de ${w.toFixed(2)}.` : 'Ganho/perda excede a largura da trava — erro de dado.'));
    if (isDebit && a.cost >= w) c.push(check('arb', 'Cálculo', 'Débito menor que a largura', 'block', 'Débito ≥ largura: operação sem possibilidade de lucro.'));
  }
  const directional = !['neutra-credito', 'neutra-debito', 'calendario'].includes(fam);
  if (directional && Math.abs(dir.bias) >= 10) {
    const okSign = Math.sign(a.greeks.delta) === Math.sign(dir.bias);
    c.push(check('calc-delta', 'Cálculo', 'Delta da posição alinhado ao viés', okSign ? 'ok' : 'block', okSign ? `Delta líquido ${a.greeks.delta.toFixed(2)} no sentido do viés ${dir.label}.` : 'Delta da estrutura contra o viés — montagem incoerente.'));
  }
  if (chain.real) {
    for (const l of a.legs) {
      const intrinsic = Math.max(0, l.type === 'call' ? ctx.S - l.strike : l.strike - ctx.S);
      if (l.bid > l.ask && l.ask > 0) c.push(check(`bidask-${l.symbol}`, 'Dados', 'Bid ≤ Ask', 'block', `${l.symbol}: bid acima do ask (dado inválido).`));
      if (l.type === 'put' || ctx.market === 'US') {
        if (l.mid < intrinsic * 0.97 - 0.02) c.push(check(`intr-${l.symbol}`, 'Dados', 'Prêmio ≥ valor intrínseco', 'block', `${l.symbol}: prêmio abaixo do intrínseco — cotação defasada ou errada.`));
      }
      if (l.iv != null && (l.iv < 0.03 || l.iv > 2.5)) c.push(check(`iv-${l.symbol}`, 'Dados', 'VI plausível', 'block', `${l.symbol}: VI ${(l.iv * 100).toFixed(0)}% fora da faixa plausível.`));
      if (l.providerDelta != null && l.delta != null && Math.abs(l.providerDelta - l.delta) > 0.15) c.push(check(`dlt-${l.symbol}`, 'Dados', 'Delta confere com o fornecedor', 'warn', `${l.symbol}: delta próprio ${l.delta.toFixed(2)} x fornecedor ${l.providerDelta.toFixed(2)}.`));
    }
  }

  // ---------- C) Risco de mercado ----------
  c.push(check('unlimited', 'Risco', 'Risco limitado', a.unlimitedLoss ? 'block' : 'ok', a.unlimitedLoss ? 'Venda descoberta de call: perda teoricamente ilimitada. Bloqueado por política.' : 'Perda máxima conhecida antes da entrada.'));
  if (a.key === 'short_put') {
    c.push(check('shortput-stress', 'Risco', 'Venda de put em estresse', ctx.regime.stress ? 'block' : 'ok', ctx.regime.stress ? 'Venda de put coberta bloqueada em regime de estresse (gaps de baixa).' : 'Regime permite venda coberta.'));
    c.push(check('assign', 'Risco', 'Exercício', 'warn', `Se exercido, você compra ${a.lot * Math.max(1, a.lots)} ações a ${a.legs[0].strike.toFixed(2)}. Só faça se quiser o papel nesse preço.`));
  }
  const minDte = Math.min(...a.legs.map((l) => l.dte));
  if (minDte < 7) c.push(check('dte-min', 'Risco', 'Prazo mínimo', 'block', `Perna com ${minDte.toFixed(0)} dias: gama e risco de "pin" altos demais.`));
  else if (isDebit && fam === 'direcional-debito' && minDte < 21) c.push(check('dte-long', 'Risco', 'Prazo para compra a seco', 'block', `Compra com ${minDte.toFixed(0)} dias: o theta consome o prêmio rápido demais.`));
  else c.push(check('dte', 'Risco', 'Prazo adequado', 'ok', `${minDte.toFixed(0)} dias até o vencimento mais curto.`));

  const spreads = a.legs.map((l) => l.spreadPct).filter((x) => x != null);
  if (spreads.length) {
    const mx = Math.max(...spreads);
    c.push(check('liq', 'Risco', 'Liquidez (spread)', mx > 15 ? 'block' : mx > 8 ? 'warn' : 'ok', `Maior spread entre as pernas: ${mx.toFixed(1)}%.`));
  }
  if (chain.real) {
    const lowOi = a.legs.filter((l) => l.oi != null && l.oi < 100);
    if (lowOi.length) c.push(check('oi', 'Risco', 'Contratos em aberto', 'warn', `${lowOi.map((l) => l.symbol).join(', ')} com menos de 100 contratos em aberto.`));
  }
  if (isDebit && a.beVsExpMove != null) {
    const r = a.beVsExpMove;
    c.push(check('be', 'Risco', 'Ponto de equilíbrio alcançável', r > 1.5 ? 'block' : r > 1 ? 'warn' : 'ok',
      `Precisa andar ${(a.beMove / ctx.S * 100).toFixed(1)}% até o equilíbrio; movimento esperado pela VI: ${(a.expMove / ctx.S * 100).toFixed(1)}% (${r.toFixed(2)}x).`));
  }
  if (fam === 'trava-credito' && a.widthCredit) {
    const ratio = -a.cost / a.widthCredit;
    c.push(check('credit-q', 'Risco', 'Qualidade do crédito', ratio < 0.2 ? 'block' : ratio < 0.28 ? 'warn' : 'ok', `Crédito de ${(ratio * 100).toFixed(0)}% da largura.`));
  }
  if (fam === 'direcional-debito') {
    const l = a.legs[0];
    const burn = l.theta && l.mid ? Math.abs(l.theta) / l.mid * 100 : null;
    if (burn != null) c.push(check('theta-burn', 'Risco', 'Perda diária por theta', burn > 2.5 ? 'warn' : 'ok', `Theta consome ${burn.toFixed(2)}% do prêmio por dia.`));
  }
  if (ctx.events && ctx.events.length) c.push(check('events', 'Risco', 'Eventos antes do vencimento', 'warn', ctx.events.map((e) => `${e.title} ${e.date}`).join('; ')));
  if (ctx.market === 'B3' && a.legs.some((l) => l.type === 'call' && l.side < 0) && ctx.q > 0.04) c.push(check('div', 'Risco', 'Dividendos x call vendida', 'warn', `Dividend yield estimado ${(ctx.q * 100).toFixed(1)}%: call vendida (americana) pode ser exercida antes da data-com. Confirme a agenda de proventos.`));
  if (ctx.regime.stress && !isDebit) c.push(check('stress-credit', 'Risco', 'Crédito em estresse', 'warn', 'Venda de prêmio em estresse: prêmios gordos, mas gaps podem levar à perda máxima rapidamente.'));

  // ---------- D) Gestão de risco ----------
  if (a.key === 'short_put') {
    c.push(check('size', 'Gestão', 'Caixa para exercício', a.lots >= 1 ? 'ok' : 'block', a.lots >= 1 ? `${a.lots} lote(s) usando até 25% do capital como garantia.` : 'Capital insuficiente para garantir 1 lote de venda coberta.'));
  } else {
    c.push(check('size', 'Gestão', `Risco máx. ${ctx.maxRiskPct}% do capital`, a.lots >= 1 ? 'ok' : 'block',
      a.lots >= 1 ? `${a.lots} lote(s) → risco de R$ ${(a.lots * a.riskPerLot).toFixed(0)} (limite R$ ${a.maxRiskBRL.toFixed(0)}).` : `1 lote arrisca R$ ${Number.isFinite(a.riskPerLot) ? a.riskPerLot.toFixed(0) : '∞'}, acima do limite de R$ ${a.maxRiskBRL.toFixed(0)}.`));
  }

  const blocked = c.some((x) => x.status === 'block');
  return { blocked, checks: c, blocks: c.filter((x) => x.status === 'block').map((x) => x.detail), warns: c.filter((x) => x.status === 'warn').map((x) => x.detail) };
}

module.exports = { runGuards, contextGuards };
