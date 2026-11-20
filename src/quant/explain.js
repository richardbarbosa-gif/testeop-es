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
  const { dir, vol, best, decision } = res;
  const cur = ctx.market === 'US' ? 'US$' : 'R$';
  const p = [];
  p.push({
    h: 'Leitura do cenário',
    t: `Viés ${dir.label} (${dir.bias > 0 ? '+' : ''}${dir.bias}) com confiança estatística ${dir.confidence}/100. Componentes: ` +
      dir.comps.map((c) => `${c.label} ${c.score > 0 ? '+' : ''}${Math.round(c.score)}${c.z != null ? ` (z=${c.z.toFixed(1)})` : ''}`).join(' · ') +
      `. Termômetro de risco do dia: ${ctx.regime.label} (${ctx.regime.score > 0 ? '+' : ''}${ctx.regime.score}) — descritivo; o efeito no ativo vem da calibração histórica.`,
  });
  p.push({ h: 'Gráfico (leitura do grafista)', t: ctx.ta.diagnosis.join(' ') });
  if (dir.techAudit && dir.techAudit.msg) p.push({ h: 'O gráfico funciona neste ativo? (auditoria 5 anos)', t: dir.techAudit.msg });
  if (dir.macroAudit && dir.macroAudit.msg) p.push({ h: 'Como o ativo reage a este regime? (auditoria 5 anos)', t: dir.macroAudit.msg });
  p.push({
    h: 'Volatilidade',
    t: vol.ivReal
      ? `VI ATM ${pc(vol.atmIv)} contra vol. prevista ${pc(vol.forecast)} para o prazo (EWMA ${pc(vol.ewma)} convergindo para a média de 1 ano ${pc(vol.hv252)}). VI/prevista ${vol.ratio ? vol.ratio.toFixed(2) : '—'}x: opções ${vol.label.toUpperCase()}${vol.label === 'cara' ? ' — vantagem para quem VENDE prêmio' : vol.label === 'barata' ? ' — vantagem para quem COMPRA opções' : ''}.`
      : `VI ESTIMADA ${pc(vol.atmIv)} (sem grade real). Vol. prevista ${pc(vol.forecast)}. Como a VI não é de mercado, o sistema não atribui vantagem a comprar ou vender volatilidade — o ganho esperado considera só direção e tempo.`,
  });
  if (!best) return p;
  const why = best.scoreWhy.filter((w) => w.v > 0).map((w) => w.msg);
  const against = best.scoreWhy.filter((w) => w.v < 0).map((w) => w.msg);
  const head = decision && decision.level === 'nao_vale' ? `Por que, se for operar, ${best.name}` : `Por que ${best.name}`;
  p.push({
    h: head,
    t: `${why.length ? why.join('; ') + '.' : ''} Probabilidade de lucro: ${pc(best.pop)} pela precificação do mercado e ${pc(best.popPhys)} no cenário calibrado. ` +
      `Ganho esperado ${best.evPhys >= 0 ? '+' : '−'}${money(best.evPhys * best.lot, cur)} por lote; ganho máx. ${best.unlimitedGain ? 'ilimitado' : money(best.maxProfit * best.lot, cur)}; perda máx. ${money(best.maxLoss * best.lot, cur)} por lote. ` +
      `Gregas (por opção): Δ ${f2(best.greeks.delta)}, Γ ${best.greeks.gamma.toFixed(4)}, Θ ${best.greeks.theta.toFixed(3)}/dia, Vega ${f2(best.greeks.vega)}.` +
      (against.length ? ` Pontos contra: ${against.join('; ')}.` : ''),
  });
  const alts = [...(res.alternatives || []), ...(res.rejected || [])].slice(0, 6);
  if (alts.length) p.push({ h: 'Por que não as outras', t: alts.map((a) => (a.guard.blocked ? `${a.name}: BLOQUEADA — ${a.guard.blocks[0]}` : `${a.name}: nota ${a.score}, ganho esperado ${(a.ror * 100).toFixed(1)}% do risco`)).join(' | ') });
  return p;
}

function execution(best, ctx, decision) {
  if (!best) return [];
  const steps = [];
  const lot = best.lot;
  const multi = best.legs.length > 1;
  const lv = decision ? decision.level : 'operar';
  if (lv === 'nao_vale') steps.push(`ATENÇÃO: o sistema NÃO vê vantagem estatística. Se mesmo assim for operar, use no máximo ${best.lots} lote(s) — 1/3 do tamanho normal (${best.lotsFull}).`);
  else if (lv === 'reduzido') steps.push(`Tamanho reduzido: ${best.lots} lote(s), metade do tamanho normal (${best.lotsFull}).`);
  steps.push(`Quantidade: ${best.lots} lote(s) de ${lot} (${best.lots * lot} opções por perna). Risco total ≈ R$ ${(best.lots * best.riskPerLot).toFixed(0)}.`);
  best.legs.forEach((l, i) => steps.push(`Perna ${i + 1}: ${legText(l, ctx)}`));
  if (best.legs.some((l) => l.theoretical)) steps.push('Preços teóricos: abra o book, confirme código da série, prêmio real e volume. Se o prêmio real divergir mais de 15% do teórico, gere a análise de novo antes de entrar.');
  if (multi) steps.push('Envie como ESTRUTURA única (boleta de estratégia do home broker) para não ficar com uma perna sozinha. Se montar perna a perna: primeiro a perna COMPRADA; nunca deixe uma venda descoberta.');
  const net = Math.abs(best.cost);
  steps.push(`Ordem LIMITADA no ${best.debit ? 'débito' : 'crédito'} líquido de ${f2(net)}. Melhore no máximo 2 ticks; ${best.debit ? `não pague acima de ${f2(net * 1.08)}` : `não aceite crédito abaixo de ${f2(net * 0.92)}`}. Nunca use ordem a mercado.`);
  if (ctx.lead && Math.abs(ctx.lead.adrPost || 0) >= 1.5) steps.push('Gap provável na abertura: espere 15–30 min para o spread das opções normalizar.');
  const fam = best.family;
  const sup = ctx.ta.supports[0] || { price: ctx.ta.lo52, synthetic: 'mínima de 52 semanas' };
  const res = ctx.ta.resistances[0] || { price: ctx.ta.hi52, synthetic: 'máxima de 52 semanas' };
  const lvl = (x, nome) => `${x.synthetic || nome} ${f2(x.price)}`;
  if (fam === 'direcional-debito') {
    steps.push(`Alvo: realizar 50–100% de lucro sobre o prêmio, ou parcial perto de ${best.legs[0].type === 'call' ? lvl(res, 'resistência') : lvl(sup, 'suporte')}.`);
    steps.push('Stop: sair se o prêmio cair 40–50% ou se o ativo fechar do lado errado da MME20.');
    steps.push('Stop de tempo: zerar faltando 21 dias para o vencimento se o movimento não veio.');
  } else if (fam === 'trava-debito') {
    steps.push('Alvo: encerrar com 60–75% do ganho máximo.');
    steps.push('Stop: sair se a trava perder 50% do valor pago ou se o nível-chave for rompido contra você.');
  } else if (fam === 'trava-credito' || fam === 'neutra-credito' || fam === 'venda-coberta') {
    steps.push('Alvo: recomprar com 50% do crédito capturado.');
    steps.push('Stop: recomprar se a estrutura custar 2x o crédito recebido ou se o strike vendido for tocado.');
    steps.push('Gestão de tempo: encerrar ou rolar faltando ~21 dias, mesmo no lucro.');
  } else if (fam === 'diagonal' || fam === 'calendario') {
    steps.push('Gestão: no vencimento da série curta, recompre-a e venda a próxima (rolagem) se o cenário se mantiver.');
    steps.push('Stop: sair se a estrutura perder 35–40% do débito.');
  } else if (fam === 'neutra-debito') {
    steps.push('Alvo: realizar com 25–40% de lucro após o movimento; sair antes de 21 dias para o vencimento.');
  }
  steps.push(`Níveis para monitorar: ${lvl(sup, 'suporte')} · ${lvl(res, 'resistência')} · MME20 ${f2(ctx.ta.ma.e20)}.`);
  steps.push('Registre no Diário para acompanhar o resultado e medir a taxa de acerto real do sistema.');
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
