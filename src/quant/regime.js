'use strict';
// Termômetro de regime de risco para Brasil (-100 aversão a risco … +100 apetite a risco).
// Cada componente é explícito, com peso limitado: nenhum indicador sozinho domina a leitura.

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

function regime(q, ext, news) {
  // q: mapa símbolo -> cotação { price, prev, chg }; ext: mapa ADR -> pós-mercado
  const comps = [];
  const add = (id, label, val, detail) => comps.push({ id, label, val: Math.round(val * 10) / 10, detail });
  const miss = [];
  const need = (s) => (q[s] && Number.isFinite(q[s].price) ? q[s] : (miss.push(s), null));

  const vix = need('^VIX');
  if (vix) {
    const v = vix.price;
    const lvl = v < 14 ? 10 : v < 18 ? 5 : v < 22 ? 0 : v < 28 ? -10 : v < 35 ? -18 : -25;
    const ch = vix.chg > 10 ? -8 : vix.chg < -8 ? 5 : 0;
    add('vix', 'VIX', lvl + ch, `VIX ${v.toFixed(1)} (${fmt(vix.chg)} no dia)`);
  }
  const vxewz = need('^VXEWZ');
  if (vxewz) {
    const v = vxewz.price;
    add('vxewz', 'VXEWZ', v > 45 ? -12 : v > 38 ? -6 : v < 28 ? 5 : 0, `vol. implícita do EWZ em ${v.toFixed(1)}`);
  }
  const dxy = need('DX-Y.NYB');
  if (dxy) add('dxy', 'DXY', clamp(-dxy.chg * 15, -10, 10), `DXY ${fmt(dxy.chg)} (dólar ${dxy.chg > 0 ? 'mais forte' : 'mais fraco'} no mundo)`);
  const brl = need('BRL=X');
  if (brl) add('brl', 'USD/BRL', clamp(-brl.chg * 8, -12, 12), `dólar/real ${fmt(brl.chg)} (${brl.price.toFixed(4)})`);
  const tnx = need('^TNX');
  if (tnx && tnx.prev) {
    const bps = (tnx.price - tnx.prev) * 100;
    add('ust10', 'Treasury 10a', clamp(-bps * 0.6, -8, 8), `10 anos EUA ${tnx.price.toFixed(2)}% (${bps >= 0 ? '+' : ''}${bps.toFixed(0)} bps)`);
  }
  const es = need('ES=F');
  if (es) add('es', 'S&P futuro', clamp(es.chg * 6, -10, 10), `S&P futuro ${fmt(es.chg)}`);
  const asia = ['^N225', '^HSI', '000001.SS', '^KS11', '^AXJO'].map((s) => q[s]).filter((x) => x && Number.isFinite(x.chg));
  if (asia.length >= 3) {
    const avg = asia.reduce((a, b) => a + b.chg, 0) / asia.length;
    add('asia', 'Ásia', clamp(avg * 4, -8, 8), `média Ásia ${fmt(avg)} (${asia.length} bolsas)`);
  } else miss.push('Ásia');
  const eu = ['^STOXX50E', '^GDAXI', '^FTSE'].map((s) => q[s]).filter((x) => x && Number.isFinite(x.chg));
  if (eu.length >= 2) {
    const avg = eu.reduce((a, b) => a + b.chg, 0) / eu.length;
    add('europa', 'Europa', clamp(avg * 3, -6, 6), `média Europa ${fmt(avg)}`);
  }
  const ewzX = ext && ext.EWZ && ext.EWZ.post;
  if (ewzX && Date.now() / 1000 - ewzX.time < 18 * 3600) add('afterEWZ', 'After-market EWZ', clamp(ewzX.chg * 6, -10, 10), `EWZ no after ${fmt(ewzX.chg)} vs fechamento`);
  const com = ['BZ=F', 'HG=F'].map((s) => q[s]).filter((x) => x && Number.isFinite(x.chg));
  if (com.length) {
    const avg = com.reduce((a, b) => a + b.chg, 0) / com.length;
    add('commod', 'Commodities BR', clamp(avg * 2, -6, 6), `Brent/cobre média ${fmt(avg)}`);
  }
  if (news && Number.isFinite(news.sentiment) && news.items && news.items.length >= 10) add('news', 'Noticiário', clamp(news.sentiment * 5, -6, 6), `sentimento médio ${news.sentiment.toFixed(2)} em ${news.items.length} manchetes`);

  const score = clamp(comps.reduce((a, c) => a + c.val, 0), -100, 100);
  const expected = 11;
  const quorum = comps.length / expected;
  let label = 'Neutro';
  if (score >= 30) label = 'Apetite a risco (risk-on)';
  else if (score >= 10) label = 'Levemente positivo';
  else if (score <= -30) label = 'Aversão a risco (risk-off)';
  else if (score <= -10) label = 'Cautela';
  const stress = Boolean((vix && vix.price >= 30) || (vxewz && vxewz.price >= 45));
  return { score: Math.round(score), label, stress, comps, quorum: Math.round(quorum * 100), missing: miss };
}

function fmt(x) {
  if (!Number.isFinite(x)) return '—';
  return `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`;
}

module.exports = { regime };
