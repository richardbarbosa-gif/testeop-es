'use strict';
// Banco Central do Brasil — SGS (séries oficiais) e Focus (expectativas de mercado). Gratuito e oficial.
const { cached, fetchJson } = require('../lib/net');

const SGS = {
  selic: 432, // Meta Selic (% a.a.)
  cdi: 4389, // CDI anualizado (% a.a.)
  ptax: 1, // Dólar PTAX venda
  ipca12m: 13522, // IPCA acumulado 12 meses
};

function parseBr(v) {
  return Number(String(v).replace(',', '.'));
}

// A API do SGS limita "ultimos" a 20 registros; para janelas maiores usa dataInicial.
function sgs(code, n = 20) {
  return cached(`sgs:${code}:${n}`, 30 * 60e3, async () => {
    let url;
    if (n <= 20) url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${code}/dados/ultimos/${n}?formato=json`;
    else {
      const d = new Date(Date.now() - n * 86400e3);
      const di = `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
      url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${code}/dados?formato=json&dataInicial=${di}`;
    }
    const arr = await fetchJson(url);
    if (!Array.isArray(arr)) throw new Error('SGS: resposta inesperada');
    return arr.map((x) => ({ date: x.data, value: parseBr(x.valor) })).filter((x) => Number.isFinite(x.value));
  });
}

const OLINDA = 'https://olinda.bcb.gov.br/olinda/servico/Expectativas/versao/v1/odata/';

// Caminho esperado da Selic por reunião do Copom (mediana Focus). É o substituto
// gratuito e oficial para a curva de DI futuro (que a B3 não disponibiliza de forma aberta).
function focusSelicPath() {
  return cached('focus:selic', 3 * 3600e3, async () => {
    const url = `${OLINDA}ExpectativasMercadoSelic?$top=60&$orderby=Data%20desc&$filter=baseCalculo%20eq%200&$format=json&$select=Data,Reuniao,Mediana`;
    const j = await fetchJson(url);
    const rows = j.value || [];
    if (!rows.length) return { date: null, path: [] };
    const date = rows[0].Data;
    const latest = rows.filter((r) => r.Data === date);
    const parseR = (s) => {
      const m = /^R(\d)\/(\d{4})$/.exec(s);
      return m ? Number(m[2]) * 10 + Number(m[1]) : 0;
    };
    latest.sort((a, b) => parseR(a.Reuniao) - parseR(b.Reuniao));
    return { date, path: latest.map((r) => ({ meeting: r.Reuniao, selic: r.Mediana })) };
  });
}

function focusAnnual(indicador) {
  return cached(`focus:${indicador}`, 3 * 3600e3, async () => {
    const url = `${OLINDA}ExpectativasMercadoAnuais?$top=12&$orderby=Data%20desc&$filter=Indicador%20eq%20'${encodeURIComponent(indicador)}'%20and%20baseCalculo%20eq%200&$format=json&$select=Indicador,Data,DataReferencia,Mediana`;
    const j = await fetchJson(url);
    const rows = j.value || [];
    if (!rows.length) return { date: null, years: [] };
    const date = rows[0].Data;
    return { date, years: rows.filter((r) => r.Data === date).map((r) => ({ year: r.DataReferencia, value: r.Mediana })).sort((a, b) => a.year - b.year) };
  });
}

async function snapshot() {
  const [selic, cdi, ptax, ipca, path, ipcaExp, cambioExp, pibExp] = await Promise.allSettled([
    sgs(SGS.selic, 730),
    sgs(SGS.cdi, 5),
    sgs(SGS.ptax, 20),
    sgs(SGS.ipca12m, 13),
    focusSelicPath(),
    focusAnnual('IPCA'),
    focusAnnual('Câmbio'),
    focusAnnual('PIB Total'),
  ]);
  const v = (x) => (x.status === 'fulfilled' ? x.value : null);
  const selicSeries = v(selic);
  // Última mudança de Selic (para contexto de ciclo)
  let lastMove = null;
  if (selicSeries && selicSeries.length > 1) {
    for (let i = selicSeries.length - 1; i > 0; i--) {
      if (selicSeries[i].value !== selicSeries[i - 1].value) {
        lastMove = { date: selicSeries[i].date, from: selicSeries[i - 1].value, to: selicSeries[i].value };
        break;
      }
    }
  }
  const last = (s) => (s && s.length ? s[s.length - 1] : null);
  return {
    selic: last(selicSeries),
    selicLastMove: lastMove,
    cdi: last(v(cdi)),
    ptax: last(v(ptax)),
    ptaxSeries: v(ptax),
    ipca12m: last(v(ipca)),
    focus: { selicPath: v(path), ipca: v(ipcaExp), cambio: v(cambioExp), pib: v(pibExp) },
  };
}

module.exports = { snapshot, sgs };
