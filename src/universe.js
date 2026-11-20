'use strict';
// Universo de ativos (validado ao vivo no Yahoo em 20/11/2026) e grupos macro.
// Qualquer outro ticker da B3 (ex.: ABCD3) ou dos EUA (ex.: AAPL) pode ser buscado:
// resolve() cria a definição na hora e a existência é confirmada pelos dados.

// [ticker, nome, ADR para "antecedentes", fatores (commodities/câmbio)]
const GROUPS = [
  { id: 'idx', title: 'Índice e ETFs', items: [['BOVA11', 'ETF Ibovespa', 'EWZ'], ['SMAL11', 'ETF Small Caps', 'EWZ']] },
  { id: 'oil', title: 'Petróleo e combustíveis', items: [['PETR4', 'Petrobras PN', 'PBR', ['BZ=F']], ['PETR3', 'Petrobras ON', 'PBR', ['BZ=F']], ['PRIO3', 'PRIO', null, ['BZ=F']], ['BRAV3', 'Brava Energia', null, ['BZ=F']], ['RECV3', 'PetroReconcavo', null, ['BZ=F']], ['CSAN3', 'Cosan', null], ['VBBR3', 'Vibra', null], ['UGPA3', 'Ultrapar', 'UGP']] },
  { id: 'min', title: 'Mineração e siderurgia', items: [['VALE3', 'Vale', 'VALE', ['HG=F']], ['BRAP4', 'Bradespar', 'VALE', ['HG=F']], ['CMIN3', 'CSN Mineração', null, ['HG=F']], ['GGBR4', 'Gerdau', 'GGB'], ['GOAU4', 'Metalúrgica Gerdau', 'GGB'], ['CSNA3', 'CSN', null], ['USIM5', 'Usiminas', null]] },
  { id: 'fin', title: 'Bancos e financeiro', items: [['ITUB4', 'Itaú Unibanco', 'ITUB'], ['BBDC4', 'Bradesco', 'BBD'], ['BBAS3', 'Banco do Brasil'], ['SANB11', 'Santander Brasil'], ['BPAC11', 'BTG Pactual'], ['ITSA4', 'Itaúsa', 'ITUB'], ['B3SA3', 'B3'], ['BBSE3', 'BB Seguridade'], ['CXSE3', 'Caixa Seguridade'], ['IRBR3', 'IRB Re']] },
  { id: 'ene', title: 'Energia e saneamento', items: [['AXIA3', 'Eletrobras (Axia)'], ['CMIG4', 'Cemig'], ['CPLE3', 'Copel'], ['EQTL3', 'Equatorial'], ['SBSP3', 'Sabesp', 'SBS'], ['EGIE3', 'Engie Brasil'], ['ENEV3', 'Eneva']] },
  { id: 'cons', title: 'Consumo, varejo e alimentos', items: [['ABEV3', 'Ambev', 'ABEV'], ['MGLU3', 'Magazine Luiza'], ['LREN3', 'Lojas Renner'], ['ASAI3', 'Assaí'], ['RADL3', 'Raia Drogasil'], ['NATU3', 'Natura'], ['MBRF3', 'MBRF (BRF+Marfrig)'], ['BEEF3', 'Minerva'], ['JBSS32', 'JBS (BDR)'], ['SLCE3', 'SLC Agrícola'], ['SMTO3', 'São Martinho']] },
  { id: 'ind', title: 'Indústria, papel e transporte', items: [['WEGE3', 'WEG'], ['EMBJ3', 'Embraer'], ['SUZB3', 'Suzano', 'SUZ', ['BRL=X']], ['KLBN11', 'Klabin', null, ['BRL=X']], ['RAIL3', 'Rumo'], ['MOTV3', 'Motiva (ex-CCR)'], ['RENT3', 'Localiza'], ['POMO4', 'Marcopolo']] },
  { id: 'hea', title: 'Saúde e educação', items: [['RDOR3', 'Rede D\'Or'], ['HAPV3', 'Hapvida'], ['HYPE3', 'Hypera'], ['COGN3', 'Cogna'], ['YDUQ3', 'Yduqs']] },
  { id: 're', title: 'Imobiliário e shoppings', items: [['CYRE3', 'Cyrela'], ['MRVE3', 'MRV'], ['CURY3', 'Cury'], ['DIRR3', 'Direcional'], ['ALOS3', 'Allos'], ['MULT3', 'Multiplan']] },
  { id: 'tech', title: 'Tecnologia e telecom', items: [['TOTS3', 'Totvs'], ['VIVT3', 'Vivo'], ['TIMS3', 'TIM']] },
  { id: 'us', title: 'EUA (opções americanas)', items: [['EWZ', 'iShares MSCI Brazil'], ['PBR', 'Petrobras ADR', null, ['BZ=F']], ['VALE', 'Vale ADR', null, ['HG=F']], ['ITUB', 'Itaú ADR'], ['NU', 'Nubank'], ['SPY', 'S&P 500 ETF'], ['QQQ', 'Nasdaq 100 ETF']] },
];

const US_SET = new Set(GROUPS.find((g) => g.id === 'us').items.map((i) => i[0]));
const UNDERLYINGS = {};
for (const g of GROUPS) {
  for (const [t, name, adr, factors] of g.items) {
    UNDERLYINGS[t] = { y: US_SET.has(t) ? t : `${t}.SA`, market: US_SET.has(t) ? 'US' : 'B3', name, factors: factors || [], adr: adr || null, group: g.id, groupTitle: g.title };
  }
}

const B3_RX = /^[A-Z]{4}(3|4|5|6|11|32|33|34|35)$/;
const US_RX = /^[A-Z]{1,5}$/;

// Resolve um ticker (do universo ou digitado). Retorna null se o formato for inválido.
function resolve(raw) {
  const t = String(raw || '').trim().toUpperCase().replace(/\.SA$/, '');
  if (UNDERLYINGS[t]) return { ticker: t, ...UNDERLYINGS[t] };
  if (B3_RX.test(t)) return { ticker: t, y: `${t}.SA`, market: 'B3', name: t, factors: [], adr: null, group: 'custom', groupTitle: 'Buscados', custom: true };
  if (US_RX.test(t)) return { ticker: t, y: t, market: 'US', name: t, factors: [], adr: null, group: 'custom', groupTitle: 'Buscados', custom: true };
  return null;
}

const MACRO_GROUPS = [
  { id: 'brasil', title: 'Brasil', items: [['^BVSP', 'Ibovespa'], ['BRL=X', 'Dólar (USD/BRL)'], ['BOVA11.SA', 'BOVA11'], ['EWZ', 'EWZ (NY)']] },
  { id: 'eua', title: 'EUA', items: [['^GSPC', 'S&P 500'], ['^IXIC', 'Nasdaq'], ['^DJI', 'Dow Jones'], ['ES=F', 'S&P fut.'], ['NQ=F', 'Nasdaq fut.']] },
  { id: 'vol', title: 'Volatilidade', items: [['^VIX', 'VIX'], ['^VXEWZ', 'VXEWZ (vol. Brasil)'], ['^VVIX', 'VVIX'], ['^MOVE', 'MOVE (vol. Treasuries)'], ['^VXEEM', 'VXEEM (emergentes)']] },
  { id: 'juros', title: 'Juros EUA', yields: true, items: [['^IRX', 'T-Bill 3m'], ['^FVX', 'Treasury 5a'], ['^TNX', 'Treasury 10a'], ['^TYX', 'Treasury 30a']] },
  { id: 'dolar', title: 'Dólar global', items: [['DX-Y.NYB', 'DXY'], ['MXN=X', 'USD/MXN'], ['CNY=X', 'USD/CNY'], ['EURUSD=X', 'EUR/USD']] },
  { id: 'asia', title: 'Ásia (fechamento)', items: [['^N225', 'Nikkei 225'], ['^HSI', 'Hang Seng'], ['000001.SS', 'Xangai'], ['^KS11', 'Kospi'], ['^AXJO', 'ASX 200']] },
  { id: 'europa', title: 'Europa', items: [['^STOXX50E', 'Euro Stoxx 50'], ['^GDAXI', 'DAX'], ['^FTSE', 'FTSE 100']] },
  { id: 'commod', title: 'Commodities', items: [['BZ=F', 'Petróleo Brent'], ['CL=F', 'Petróleo WTI'], ['HG=F', 'Cobre'], ['GC=F', 'Ouro']] },
];

const ADRS = ['EWZ', 'PBR', 'VALE', 'ITUB', 'BBD', 'ABEV', 'SUZ', 'GGB', 'SBS', 'UGP'];

module.exports = { UNDERLYINGS, GROUPS, MACRO_GROUPS, ADRS, resolve };
