'use strict';
// Justificativa ("por que esta operação") e plano de execução ("como executar").
// Gerados por regras a partir dos números do motor. Se ANTHROPIC_API_KEY existir, o Claude
// reescreve a análise em linguagem de mesa — recebendo APENAS os fatos calculados e proibido
// de inventar números.
const { config } = require('../config');

const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '—');
const pc = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : '—');
const money = (x, cur) => (Number.isFinite(x) ? `${cur} ${Math.abs(x).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'ilimitado');

function legText(l, ctx) {
  const side = l.side > 0 ? 'COMPRA' : 'VENDA';
  const tipo = l.type === 'call' ? 'CALL' : 'PUT';
  const ser = l.theoretical ? (l.seriesHint ? ` (série ${l.seriesHint}, código a confirmar)` : '') : ` [${l.symbol}]`;
  return `${side} ${tipo} strike ${f2(l.strike)} venc. ${l.expiry}${ser} · prêmio ${f2(l.mid)} · Δ ${f2(l.delta)} · VI ${pc(l.iv)}`;
}

function rationale(res, ctx) {
  const { dir, vol, best } = res;
  const cur = ctx.market === 'US' ? 'US$' : 'R$';
  const p = [];
  p.push({
    h: 'Leitura do cenário',
    t: `Viés ${dir.label} (${dir.bias > 0 ? '+' : ''}${dir.bias}) com confiança ${dir.confidence}/100 e ${dir.agreement}% de concordância entre os componentes: ` +
      dir.comps.map((c) => `${c.label} ${c.score > 0 ? '+' : ''}${Math.round(c.score)}`).join(' · ') + '. ' +
      `Regime macro: ${ctx.regime.label} (${ctx.regime.score > 0 ? '+' : ''}${ctx.regime.score}).`,
  });
  p.push({ h: 'Gráfico', t: ctx.ta.diagnosis.join(' ') });
  p.push({
    h: 'Volatilidade',
    t: `VI ATM ${pc(vol.atmIv)}${vol.theoretical ? ' (estimada)' : ''} contra vol. histórica 20d de ${pc(vol.hv20)} (razão ${vol.ratio ? vol.ratio.toFixed(2) : '—'}x; percentil da VH ${vol.hvPct != null ? vol.hvPct.toFixed(0) : '—'}). ` +
      `Volatilidade considerada ${vol.label.toUpperCase()}${vol.label === 'cara' ? ': vantagem para quem VENDE prêmio' : vol.label === 'barata' ? ': vantagem para quem COMPRA prêmio' : ': sem vantagem clara de vega'}.`,
  });
  if (!best) return p;
  const why = best.scoreWhy.filter((w) => w.v > 0).map((w) => w.msg);
  const against = best.scoreWhy.filter((w) => w.v < 0).map((w) => w.msg);
  p.push({
    h: `Por que ${best.name}`,
    t: `${why.length ? why.join('; ') + '.' : ''} Probabilidade de lucro (mercado) ${pc(best.pop)}; no cenário do sistema ${pc(best.popSys)}. ` +
      `Ganho máx. ${money(best.maxProfit * best.lot, cur)} · perda máx. ${money(best.maxLoss * best.lot, cur)} por lote. ` +
      `Gregas da posição (por opção): Δ ${f2(best.greeks.delta)}, Γ ${best.greeks.gamma.toFixed(4)}, Θ ${Number.isFinite(best.greeks.theta) ? best.greeks.theta.toFixed(3) : '—'}/dia, Vega ${f2(best.greeks.vega)}.` +
      (against.length ? ` Pontos contra considerados: ${against.join('; ')}.` : ''),
  });
  const alts = [...(res.alternatives || []), ...(res.rejected || [])].slice(0, 6);
  if (alts.length) {
    p.push({
      h: 'Por que não as outras',
      t: alts.map((a) => a.guard.blocked ? `${a.name}: BLOQUEADA — ${a.guard.blocks[0]}` : `${a.name}: nota ${a.score} (menor que ${best.score})`).join(' | '),
    });
  }
  return p;
}

function execution(best, ctx) {
  if (!best) return [];
  const cur = ctx.market === 'US' ? 'US$' : 'R$';
  const steps = [];
  const lot = best.lot;
  const multi = best.legs.length > 1;
  steps.push(`Quantidade: ${best.lots} lote(s) de ${lot} (${best.lots * lot} opções por perna). Risco total ≈ R$ ${(best.lots * best.riskPerLot).toFixed(0)}.`);
  best.legs.forEach((l, i) => steps.push(`Perna ${i + 1}: ${legText(l, ctx)}`));
  if (best.legs.some((l) => l.theoretical)) steps.push('ATENÇÃO: preços teóricos. Abra o book, confirme código da série, prêmio real e volume. Se o prêmio real divergir mais de 15% do teórico, gere a análise de novo antes de entrar.');
  if (multi) steps.push('Envie como ESTRUTURA única (boleta de estratégia/trava do home broker) para não ficar com uma perna sozinha. Se precisar montar perna a perna: execute primeiro a perna COMPRADA e nunca deixe uma venda descoberta.');
  const net = Math.abs(best.cost);
  steps.push(`Ordem LIMITADA no ${best.debit ? 'débito' : 'crédito'} líquido de ${f2(net)} (preço médio). Melhore no máximo 2 ticks; ${best.debit ? `não pague acima de ${f2(net * 1.08)}` : `não aceite crédito abaixo de ${f2(net * 0.92)}`}. Nunca use ordem a mercado.`);
  if (ctx.lead && Math.abs(ctx.lead.adrPost || 0) >= 1.5) steps.push('Gap provável na abertura: espere 15–30 min após a abertura para o spread das opções normalizar.');
  // Saídas por família
  const fam = best.family;
  const sup = ctx.ta.supports[0], res = ctx.ta.resistances[0];
  if (fam === 'direcional-debito') {
    steps.push(`Alvo: realizar 50–100% de lucro sobre o prêmio, ou parcial perto da ${best.legs[0].type === 'call' ? `resistência ${res ? f2(res.price) : '—'}` : `suporte ${sup ? f2(sup.price) : '—'}`}.`);
    steps.push('Stop: sair se o prêmio cair 40–50% ou se o ativo fechar do lado errado da MME20.');
    steps.push('Stop de tempo: zerar faltando 21 dias para o vencimento se o movimento não veio (o theta acelera).');
  } else if (fam === 'trava-debito') {
    steps.push('Alvo: encerrar com 60–75% do ganho máximo — o restante exige ficar até o vencimento com risco de pin.');
    steps.push('Stop: sair se a trava perder 50% do valor pago ou se o suporte/resistência-chave for rompido contra você.');
  } else if (fam === 'trava-credito' || fam === 'neutra-credito' || fam === 'venda-coberta') {
    steps.push('Alvo: recomprar com 50% do crédito capturado (a maior parte do theta já foi colhida).');
    steps.push('Stop: recomprar se a estrutura custar 2x o crédito recebido, ou se o strike vendido for tocado.');
    steps.push('Gestão de tempo: encerrar ou rolar faltando ~21 dias, mesmo no lucro.');
  } else if (fam === 'diagonal' || fam === 'calendario') {
    steps.push('Gestão: no vencimento da série curta, recompre-a e venda a próxima (rolagem) se o cenário se mantiver.');
    steps.push('Stop: sair se a estrutura perder 35–40% do débito ou se o ativo romper a faixa prevista.');
  } else if (fam === 'neutra-debito') {
    steps.push('Alvo: realizar com 25–40% de lucro após o movimento; stop de tempo antes de 21 dias para o vencimento.');
  }
  if (sup || res) steps.push(`Níveis para monitorar: suporte ${sup ? f2(sup.price) : '—'} · resistência ${res ? f2(res.price) : '—'} · MME20 ${f2(ctx.ta.ma.e20)}.`);
  steps.push(`Registre no Diário (botão abaixo) para acompanhar o resultado e medir a taxa de acerto real do sistema.`);
  void cur;
  return steps;
}

async function aiNarrative(payload) {
  if (!config.providers.anthropicKey) return null;
  const sys = 'Você é um operador sênior de opções (B3 e EUA). Escreva em português do Brasil, direto, sem floreio. Use SOMENTE os números fornecidos no JSON — nunca invente preços, datas ou probabilidades. Se a decisão for NÃO OPERAR, defenda a decisão. Estruture em: Cenário, Gráfico, Volatilidade, Decisão e Riscos. No máximo 260 palavras.';
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 25000);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': config.providers.anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: config.providers.anthropicModel, max_tokens: 900, system: sys, messages: [{ role: 'user', content: JSON.stringify(payload) }] }),
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const j = await res.json();
    return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() || null;
  } catch {
    return null;
  }
}

module.exports = { rationale, execution, aiNarrative, legText };
