'use strict';
// Universo de ativos e grupos macro.

const UNDERLYINGS = {
  PETR4: { y: 'PETR4.SA', market: 'B3', name: 'Petrobras PN', factors: ['BZ=F'], adr: 'PBR' },
  VALE3: { y: 'VALE3.SA', market: 'B3', name: 'Vale ON', factors: ['HG=F'], adr: 'VALE' },
  BOVA11: { y: 'BOVA11.SA', market: 'B3', name: 'ETF Ibovespa', factors: [], adr: 'EWZ' },
  ITUB4: { y: 'ITUB4.SA', market: 'B3', name: 'Itaú Unibanco PN', factors: [], adr: 'ITUB' },
  BBAS3: { y: 'BBAS3.SA', market: 'B3', name: 'Banco do Brasil ON', factors: [], adr: null },
  BBDC4: { y: 'BBDC4.SA', market: 'B3', name: 'Bradesco PN', factors: [], adr: 'BBD' },
  B3SA3: { y: 'B3SA3.SA', market: 'B3', name: 'B3 ON', factors: [], adr: null },
  ABEV3: { y: 'ABEV3.SA', market: 'B3', name: 'Ambev ON', factors: [], adr: 'ABEV' },
  PRIO3: { y: 'PRIO3.SA', market: 'B3', name: 'PRIO ON', factors: ['BZ=F'], adr: null },
  WEGE3: { y: 'WEGE3.SA', market: 'B3', name: 'WEG ON', factors: [], adr: null },
  SUZB3: { y: 'SUZB3.SA', market: 'B3', name: 'Suzano ON', factors: ['BRL=X'], adr: 'SUZ' },
  EWZ: { y: 'EWZ', market: 'US', name: 'iShares MSCI Brazil (EUA)', factors: [], adr: null },
  PBR: { y: 'PBR', market: 'US', name: 'Petrobras ADR (EUA)', factors: ['BZ=F'], adr: null },
  VALE: { y: 'VALE', market: 'US', name: 'Vale ADR (EUA)', factors: ['HG=F'], adr: null },
};

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

const ADRS = ['EWZ', 'PBR', 'VALE', 'ITUB', 'BBD'];

module.exports = { UNDERLYINGS, MACRO_GROUPS, ADRS };
