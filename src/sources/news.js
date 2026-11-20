'use strict';
// Notícias via RSS públicos (InfoMoney + Google News). Sentimento por léxico — heurístico,
// serve para medir "temperatura" do noticiário, não para decidir sozinho.
const { XMLParser } = require('fast-xml-parser');
const { cached, fetchText, settle } = require('../lib/net');

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' });

const FEEDS = [
  { id: 'infomoney', name: 'InfoMoney', url: 'https://www.infomoney.com.br/feed/' },
  { id: 'gn-mercado', name: 'Google News', url: gn('Ibovespa OR "bolsa brasileira" OR "mercado financeiro"') },
  { id: 'gn-macro', name: 'Google News', url: gn('Copom OR Fed OR FOMC OR "juros futuros" OR "dólar hoje"') },
  { id: 'gn-world', name: 'Google News', url: gn('"Wall Street" OR China OR petróleo OR "minério de ferro" OR tarifas', 'pt-BR') },
  { id: 'gn-empresas', name: 'Google News', url: gn('Petrobras OR Vale OR Itaú OR Bradesco OR "Banco do Brasil" resultado OR balanço OR dividendos') },
];

function gn(q, hl = 'pt-BR') {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:2d')}&hl=${hl}&gl=BR&ceid=BR:pt-419`;
}

const POS = ['alta', 'sobe', 'subiu', 'dispara', 'avança', 'avanço', 'recorde', 'lucro', 'supera', 'otimismo', 'recupera', 'ganho', 'compra', 'eleva', 'corte de juros', 'cortar juros', 'acordo', 'estímulo', 'forte demanda', 'melhora', 'upgrade', 'dividendos'];
const NEG = ['queda', 'cai', 'caiu', 'despenca', 'derrete', 'recua', 'prejuízo', 'crise', 'guerra', 'tarifa', 'sanção', 'recessão', 'inflação sobe', 'alta de juros', 'aperto', 'pessimismo', 'perde', 'perda', 'rebaixa', 'downgrade', 'risco fiscal', 'calote', 'tensão', 'ataque', 'pânico', 'aversão ao risco', 'fuga'];

const TAGS = {
  PETR4: ['petrobras', 'petr4', 'petróleo', 'brent', 'pbr'],
  VALE3: ['vale', 'vale3', 'minério'],
  ITUB4: ['itaú', 'itau', 'itub4'],
  BBDC4: ['bradesco', 'bbdc4'],
  BBAS3: ['banco do brasil', 'bbas3'],
  IBOV: ['ibovespa', 'bolsa', 'b3'],
  USD: ['dólar', 'câmbio', 'real brasileiro', 'moeda'],
  JUROS: ['copom', 'selic', 'juros', 'di futuro', ' fed', 'fomc', 'treasur', 'inflação', 'ipca', 'payroll'],
  CHINA: ['china', 'chinês', 'chinesa', 'pequim'],
  GLOBAL: ['wall street', 'nasdaq', 's&p', 'dow jones', 'bolsas', 'ações', 'mercados', 'investidores', 'tarifa', 'recessão', 'petróleo', 'commodities', 'bitcoin'],
};

function score(text) {
  const t = ` ${text.toLowerCase()} `;
  let s = 0;
  for (const w of POS) if (t.includes(w)) s += 1;
  for (const w of NEG) if (t.includes(w)) s -= 1;
  return Math.max(-3, Math.min(3, s));
}

function tagsOf(text) {
  const t = text.toLowerCase();
  return Object.entries(TAGS).filter(([, ws]) => ws.some((w) => t.includes(w))).map(([k]) => k);
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c))).replace(/\s+/g, ' ').trim();
}

async function readFeed(f) {
  return cached(`rss:${f.id}`, 5 * 60e3, async () => {
    const xml = await fetchText(f.url, { timeout: 10000 });
    const j = parser.parse(xml);
    let items = (j.rss && j.rss.channel && j.rss.channel.item) || [];
    if (!Array.isArray(items)) items = [items];
    return items.slice(0, 40).map((it) => {
      const title = stripHtml(it.title);
      const source = (it.source && (it.source['#text'] || it.source)) || f.name;
      const link = String(it.link || '');
      return {
        title,
        link: /^https?:\/\//.test(link) ? link : null,
        source: typeof source === 'string' ? source : f.name,
        time: it.pubDate ? Date.parse(it.pubDate) : null,
        sentiment: score(title),
        tags: tagsOf(title),
      };
    });
  });
}

async function latest() {
  const res = await settle(FEEDS.map((f) => () => readFeed(f)));
  const seen = new Set();
  const items = [];
  for (const r of res) {
    if (!r.ok) continue;
    for (const it of r.value) {
      const key = it.title.toLowerCase().slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(it);
    }
  }
  const cutoff = Date.now() - 3 * 86400e3;
  // Só manchetes ligadas a mercado (com ao menos uma etiqueta) entram no painel e no sentimento.
  const fresh = items.filter((i) => i.tags.length && (!i.time || i.time > cutoff)).sort((a, b) => (b.time || 0) - (a.time || 0)).slice(0, 80);
  const agg = fresh.reduce((a, i) => a + i.sentiment, 0);
  const byTag = {};
  for (const i of fresh) for (const t of i.tags) {
    byTag[t] = byTag[t] || { n: 0, s: 0 };
    byTag[t].n++;
    byTag[t].s += i.sentiment;
  }
  return {
    items: fresh,
    sentiment: fresh.length ? agg / fresh.length : 0,
    byTag,
    sourcesOk: res.filter((r) => r.ok).length,
    sourcesTotal: FEEDS.length,
  };
}

module.exports = { latest };
