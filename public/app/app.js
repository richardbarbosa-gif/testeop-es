(function () {
  'use strict';

  // ---------------- utilidades ----------------
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function n(x, d) { if (x == null || !isFinite(x)) return '—'; return Number(x).toLocaleString('pt-BR', { minimumFractionDigits: d == null ? 2 : d, maximumFractionDigits: d == null ? 2 : d }); }
  function pct(x, d) { if (x == null || !isFinite(x)) return '—'; return (x > 0 ? '+' : '') + n(x, d == null ? 2 : d) + '%'; }
  function sgn(x) { return x == null || !isFinite(x) ? '' : x > 0 ? 'up' : x < 0 ? 'down' : ''; }
  function money(x, cur) { if (x === Infinity) return 'ilimitado'; if (x === -Infinity) return '−ilimitado'; if (x == null || !isFinite(x)) return '—'; return (x < 0 ? '−' : '') + (cur || 'R$') + ' ' + n(Math.abs(x)); }
  function ago(ts) { if (!ts) return ''; var m = Math.round((Date.now() - ts) / 60000); return m < 1 ? 'agora' : m < 60 ? 'há ' + m + ' min' : 'há ' + Math.round(m / 60) + ' h'; }
  function toast(msg) { var t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(function () { t.hidden = true; }, 4000); }
  var store = { get: function (k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }, set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* sem armazenamento */ } } };

  function api(path, opts) {
    opts = opts || {};
    var headers = { 'X-Requested-With': 'orx' };
    if (opts.body) headers['Content-Type'] = 'application/json';
    return fetch(path, { method: opts.method || 'GET', headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined, credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 401) { location.replace('/login'); throw new Error('Sessão expirada'); }
        return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Erro'); return j; });
      });
  }

  function spark(arr, color) {
    if (!arr || arr.length < 2) return '';
    var mn = Math.min.apply(null, arr), mx = Math.max.apply(null, arr), w = 64, h = 22;
    var pts = arr.map(function (v, i) { return (i / (arr.length - 1) * w).toFixed(1) + ',' + (h - 2 - (mx === mn ? 0.5 : (v - mn) / (mx - mn)) * (h - 4)).toFixed(1); }).join(' ');
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true"><polyline fill="none" stroke="' + color + '" stroke-width="1.6" points="' + pts + '"/></svg>';
  }
  var C_UP = '#2fd47f', C_DN = '#ff5d5d', C_MU = '#5f7186';

  // ---------------- abas ----------------
  var current = 'overview';
  document.querySelectorAll('.tab').forEach(function (b) {
    b.addEventListener('click', function () { showTab(b.dataset.tab); });
  });
  function showTab(t) {
    current = t;
    document.querySelectorAll('.tab').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.tab === t)); });
    document.querySelectorAll('.view').forEach(function (v) { v.hidden = v.id !== 'view-' + t; });
    store.set('tab', t);
    if (t === 'analysis' && !chart) initChart();
    if (t === 'analysis' && chart) resizeChart();
    if (t === 'journal') loadJournal();
    if (t === 'scanner') loadScanner();
  }
  $('logout').addEventListener('click', function () { api('/api/logout', { method: 'POST' }).finally(function () { location.replace('/login'); }); });

  // ---------------- visão geral ----------------
  var macroData = null;
  function loadMacro() {
    return api('/api/macro').then(function (m) { macroData = m; renderMacro(m); $('updated').textContent = 'atualizado ' + new Date(m.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); })
      .catch(function (e) { $('updated').textContent = 'falha ao atualizar'; toast(e.message); });
  }

  function renderMacro(m) {
    var r = m.regime;
    $('regScore').textContent = (r.score > 0 ? '+' : '') + r.score;
    $('regScore').className = 'num ' + sgn(r.score);
    $('regLabel').textContent = r.label;
    $('needle').style.transform = 'rotate(' + (r.score * 0.9) + 'deg)';
    $('regQuorum').textContent = 'cobertura ' + r.quorum + '%';
    $('regStress').hidden = !r.stress;
    $('regCore').textContent = 'Leitura descritiva do humor do mercado hoje. O efeito histórico deste regime em cada ativo (que pode ser o oposto do intuitivo) é calibrado na aba Análise' + (m.core && m.core.score != null ? ' — índice central ' + n(m.core.score, 0) + ' (' + m.core.bucket + ').' : '.');
    var pill = $('regimePill');
    pill.textContent = 'Regime ' + (r.score > 0 ? '+' : '') + r.score + ' · ' + r.label.split(' (')[0];
    pill.className = 'pill regime-pill ' + (r.score >= 10 ? 'pos' : r.score <= -10 ? 'neg' : 'neu');
    $('regComps').innerHTML = r.comps.map(function (c) {
      var w = Math.min(50, Math.abs(c.val) / 33 * 50);
      var style = c.val >= 0 ? 'left:50%;width:' + w + '%;background:' + C_UP : 'right:50%;width:' + w + '%;background:' + C_DN;
      return '<li title="' + esc(c.detail) + '"><span class="lbl">' + esc(c.label) + '</span><span class="bar"><i style="' + style + '"></i></span><span class="v num ' + sgn(c.val) + '">' + (c.val > 0 ? '+' : '') + n(c.val, 0) + '</span></li>';
    }).join('') + (r.missing.length ? '<li class="dim" style="display:block">Sem dados: ' + esc(r.missing.join(', ')) + '</li>' : '');

    if (m.status) {
      $('mktB3').textContent = 'B3 ' + (m.status.b3 ? 'aberta' : 'fechada'); $('mktB3').className = 'pill ' + (m.status.b3 ? 'open' : 'closed');
      $('mktNY').textContent = 'NY ' + (m.status.ny ? 'aberta' : 'fechada'); $('mktNY').className = 'pill ' + (m.status.ny ? 'open' : 'closed');
    }

    // fita
    var tapeSyms = ['^BVSP', 'BRL=X', 'EWZ', '^VIX', 'DX-Y.NYB', '^TNX', 'ES=F', 'BZ=F', '^N225', '^HSI', '^STOXX50E', 'GC=F'];
    var all = {}; m.groups.forEach(function (g) { g.items.forEach(function (i) { all[i.symbol] = i; }); });
    $('tape').innerHTML = tapeSyms.map(function (s) { var i = all[s]; if (!i || i.missing) return ''; return '<span class="tape-i"><b>' + esc(i.label) + '</b><span class="num">' + n(i.price, i.price > 1000 ? 0 : 2) + '</span><span class="num ' + sgn(i.chg) + '">' + pct(i.chg) + '</span></span>'; }).join('');

    // Brasil
    var b = m.brasil || {};
    var k = [];
    if (b.selic) k.push(kpi('Selic meta', n(b.selic.value) + '%', b.selicLastMove ? 'última mudança ' + b.selicLastMove.date + ' (' + n(b.selicLastMove.from) + '→' + n(b.selicLastMove.to) + ')' : ''));
    if (b.cdi) k.push(kpi('CDI', n(b.cdi.value) + '%', b.cdi.date));
    if (b.ipca12m) k.push(kpi('IPCA 12m', n(b.ipca12m.value) + '%', b.ipca12m.date));
    if (b.ptax) k.push(kpi('Dólar PTAX', n(b.ptax.value, 4), b.ptax.date));
    var f = b.focus || {};
    var nextY = function (x) { return x && x.years && x.years.length ? x.years[0] : null; };
    if (nextY(f.ipca)) k.push(kpi('IPCA esperado ' + nextY(f.ipca).year, n(nextY(f.ipca).value) + '%', 'Focus ' + (f.ipca.date || '')));
    if (nextY(f.cambio)) k.push(kpi('Dólar esperado ' + nextY(f.cambio).year, n(nextY(f.cambio).value), 'Focus'));
    if (b.selic && b.ipca12m) k.push(kpi('Juro real ex-post', n(((1 + b.selic.value / 100) / (1 + b.ipca12m.value / 100) - 1) * 100) + '%', 'Selic ÷ IPCA 12m'));
    $('brKpis').innerHTML = k.join('') || '<div class="dim">Dados do BCB indisponíveis.</div>';
    var p = f.selicPath && f.selicPath.path ? f.selicPath.path.slice(0, 12) : [];
    if (p.length) {
      var mn = Math.min.apply(null, p.map(function (x) { return x.selic; })) - 0.5, mx = Math.max.apply(null, p.map(function (x) { return x.selic; }));
      $('selicPath').innerHTML = p.map(function (x) { var h = 10 + (x.selic - mn) / Math.max(0.25, mx - mn) * 44; return '<div class="b" title="Reunião ' + esc(x.meeting) + '"><span>' + n(x.selic) + '</span><i style="height:' + h.toFixed(0) + 'px"></i>' + esc(x.meeting.replace('/20', '/')) + '</div>'; }).join('');
    } else $('selicPath').innerHTML = '<div class="dim">Focus indisponível.</div>';

    // Calendário
    $('calendar').innerHTML = (m.calendar || []).map(function (e) {
      var imp = [1, 2, 3].map(function (i) { return '<i class="' + (i <= e.impact ? 'on' : '') + '"></i>'; }).join('');
      var d = e.date.slice(8, 10) + '/' + e.date.slice(5, 7);
      return '<li><span class="d">' + d + '</span><span>' + esc(e.title) + (e.confirmar ? '<span class="conf" title="Data a confirmar na fonte oficial">confirmar</span>' : '') + '<br><span class="away">' + (e.daysAway === 0 ? 'hoje' : 'em ' + e.daysAway + ' dia(s)') + '</span></span><span class="imp" title="Impacto">' + imp + '</span></li>';
    }).join('');

    // Grupos macro
    $('macroGroups').innerHTML = m.groups.filter(function (g) { return g.id !== 'brasil' || true; }).map(function (g) {
      return '<article class="card"><header class="card-h"><h2>' + esc(g.title) + '</h2></header>' + g.items.map(function (i) {
        if (i.missing) return '<div class="mrow"><span class="n">' + esc(i.label) + '</span><span class="p dim">—</span><span class="c dim">sem dado</span><span></span></div>';
        var chg = g.yields && i.bps != null ? (i.bps > 0 ? '+' : '') + n(i.bps, 0) + ' bps' : pct(i.chg);
        var cl = g.yields ? sgn(-(i.bps || 0)) : (i.symbol.indexOf('VIX') >= 0 || i.symbol === '^VXEWZ' || i.symbol === '^MOVE' || i.symbol === '^VVIX' || i.symbol === '^VXEEM' || i.symbol === 'BRL=X' || i.symbol === 'DX-Y.NYB') ? sgn(-(i.chg || 0)) : sgn(i.chg);
        var color = cl === 'up' ? C_UP : cl === 'down' ? C_DN : C_MU;
        if (i.suspect) return '<div class="mrow sus" title="' + esc(i.suspect) + '"><span class="n">' + esc(i.label) + '</span><span class="p num">' + n(i.price) + '</span><span class="c">dado suspeito</span><span></span></div>';
        return '<div class="mrow"><span class="n" title="' + esc(i.symbol) + '">' + esc(i.label) + '</span><span class="p num">' + n(i.price, i.price > 1000 ? 0 : g.yields ? 3 : 2) + '</span><span class="c num ' + cl + '">' + chg + '</span>' + spark(i.spark, color) + '</div>';
      }).join('') + '</article>';
    }).join('');

    // ADRs
    $('adrs').querySelector('tbody').innerHTML = m.adrs.map(function (a) {
      var post = a.post;
      return '<tr><td><b>' + esc(a.symbol) + '</b></td><td class="r num">' + n(a.regular) + '</td><td class="r num ' + sgn(a.chg) + '">' + pct(a.chg) + '</td><td class="r num">' + (post ? n(post.price) : '—') + '</td><td class="r num ' + sgn(post && post.chg) + '">' + (post ? pct(post.chg) : '—') + '</td></tr>';
    }).join('');

    // Notícias
    renderNews(m.news);
  }

  function kpi(k, v, s, cls) { return '<div class="kpi"><span class="k">' + esc(k) + '</span><span class="v num ' + (cls || '') + '">' + v + '</span>' + (s ? '<span class="s">' + esc(s) + '</span>' : '') + '</div>'; }

  var newsTag = store.get('newsTag', 'TODAS');
  function renderNews(nw) {
    if (!nw) return;
    var tags = ['TODAS', 'IBOV', 'JUROS', 'USD', 'GLOBAL', 'CHINA', 'PETR4', 'VALE3', 'ITUB4', 'BBDC4', 'BBAS3'];
    var names = { TODAS: 'Todas', IBOV: 'Ibovespa', JUROS: 'Juros/Fed', USD: 'Dólar', GLOBAL: 'Mundo', CHINA: 'China', PETR4: 'Petrobras', VALE3: 'Vale', ITUB4: 'Itaú', BBDC4: 'Bradesco', BBAS3: 'BB' };
    $('newsFilter').innerHTML = tags.map(function (t) { return '<button data-t="' + t + '" aria-pressed="' + (t === newsTag) + '">' + names[t] + (nw.byTag[t] ? ' · ' + nw.byTag[t].n : '') + '</button>'; }).join('');
    $('newsFilter').querySelectorAll('button').forEach(function (b) { b.addEventListener('click', function () { newsTag = b.dataset.t; store.set('newsTag', newsTag); renderNews(nw); }); });
    var items = nw.items.filter(function (i) { return newsTag === 'TODAS' || i.tags.indexOf(newsTag) >= 0; });
    $('newsMeta').textContent = nw.items.length + ' manchetes · sentimento ' + (nw.sentiment > 0 ? '+' : '') + n(nw.sentiment) + ' · fontes ' + nw.sourcesOk + '/' + nw.sourcesTotal;
    $('news').innerHTML = items.slice(0, 60).map(function (i) {
      var dot = i.sentiment > 0 ? 'p' : i.sentiment < 0 ? 'n' : '';
      var title = i.link ? '<a href="' + esc(i.link) + '" target="_blank" rel="noopener noreferrer">' + esc(i.title) + '</a>' : esc(i.title);
      return '<li><span class="dot ' + dot + '"></span><div>' + title + '<div class="meta">' + esc(i.source) + ' · ' + ago(i.time) + i.tags.map(function (t) { return '<span class="tg">' + esc(t) + '</span>'; }).join('') + '</div></div></li>';
    }).join('') || '<li class="dim">Nenhuma manchete para este filtro.</li>';
  }

  function loadFlow() {
    return api('/api/flow').then(function (f) {
      $('flowNote').textContent = 'atualizado ' + ago(f.at);
      var anyProv = f.providers.us || f.providers.b3;
      if (!anyProv) {
        $('optFlow').innerHTML = '<div class="note"><b>Fluxo de opções (grandes compras de call/put)</b> exige grade real com volume e contratos em aberto. Conecte <b>Tradier</b> (grátis, EWZ/PBR/VALE) ou <b>OpLab</b> (B3) e esta área passa a listar os negócios grandes automaticamente. Abaixo: anomalias de volume no ativo-objeto — o rastro que o fluxo grande deixa.</div>';
      } else if (!f.options.length) {
        $('optFlow').innerHTML = '<div class="note">Nenhum negócio de opção acima dos limites de fluxo incomum agora.</div>';
      } else {
        $('optFlow').innerHTML = '<table class="tbl"><thead><tr><th>Série</th><th>Tipo</th><th class="r">Strike</th><th class="r">Dias</th><th class="r">Volume</th><th class="r">Vol/OI</th><th class="r">Financeiro</th><th>Agressão</th></tr></thead><tbody>' + f.options.map(function (o) {
          return '<tr><td><b>' + esc(o.ticker) + '</b> <span class="dim">' + esc(o.symbol) + '</span></td><td class="' + (o.type === 'call' ? 'up' : 'down') + '">' + o.type.toUpperCase() + '</td><td class="r num">' + n(o.strike) + '</td><td class="r num">' + o.dte + '</td><td class="r num">' + n(o.volume, 0) + '</td><td class="r num">' + (o.volOi ? n(o.volOi, 1) + 'x' : '—') + '</td><td class="r num">' + n(o.notional, 0) + '</td><td>' + esc(o.side) + '</td></tr>';
        }).join('') + '</tbody></table>';
      }
      $('volFlow').querySelector('tbody').innerHTML = f.volume.map(function (r) {
        var fl = r.flag ? '<span class="flag ' + (r.flag === 'compra forte' ? 'up' : r.flag === 'venda forte' ? 'down' : 'neu') + '">' + esc(r.flag) + '</span>' : '<span class="dim">normal</span>';
        return '<tr><td><b>' + esc(r.ticker) + '</b> <span class="dim">' + esc(r.market) + '</span></td><td class="r num">' + (r.ratio ? n(r.ratio, 2) + 'x' : '—') + '</td><td class="r num ' + sgn(r.chg) + '">' + pct(r.chg) + '</td><td>' + fl + '</td></tr>';
      }).join('');
    }).catch(function () { $('flowNote').textContent = 'indisponível'; });
  }

  // ---------------- análise ----------------
  var chart, candleS, volS, e8S, e20S, s200S, priceLines = [];
  var selected = store.get('ticker', 'PETR4');

  function initChart() {
    if (!window.LightweightCharts) { $('chart').innerHTML = '<div class="empty">Biblioteca de gráficos não carregou.</div>'; return; }
    var LC = window.LightweightCharts;
    chart = LC.createChart($('chart'), {
      layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#8a9bb0', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11 },
      grid: { vertLines: { color: 'rgba(29,42,56,.6)' }, horzLines: { color: 'rgba(29,42,56,.6)' } },
      rightPriceScale: { borderColor: '#1d2a38' },
      timeScale: { borderColor: '#1d2a38', rightOffset: 4 },
      crosshair: { mode: 1 },
      autoSize: true,
    });
    candleS = chart.addCandlestickSeries({ upColor: '#2fd47f', downColor: '#ff5d5d', borderVisible: false, wickUpColor: '#2fd47f', wickDownColor: '#ff5d5d' });
    volS = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', color: 'rgba(90,169,255,.25)' });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    e8S = chart.addLineSeries({ color: '#5aa9ff', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false });
    e20S = chart.addLineSeries({ color: '#f5b83d', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false });
    s200S = chart.addLineSeries({ color: '#c77dff', lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
    loadAsset(selected);
  }
  function resizeChart() { if (chart) chart.timeScale().fitContent(); }

  // ---------- seletor de ativos (busca + setores + recentes) ----------
  var groups = [];
  var recent = store.get('recent', ['PETR4', 'VALE3', 'BOVA11', 'ITUB4', 'EWZ']);
  function flatUniverse() { var out = []; groups.forEach(function (g) { g.items.forEach(function (i) { out.push({ ticker: i.ticker, name: i.name, market: i.market, group: g.title }); }); }); return out; }
  function norm(x) { return String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
  function renderPicker(q) {
    var query = norm(q).trim();
    var html = '';
    groups.forEach(function (g) {
      var items = g.items.filter(function (i) { return !query || norm(i.ticker).indexOf(query) >= 0 || norm(i.name).indexOf(query) >= 0 || norm(g.title).indexOf(query) >= 0; });
      if (!items.length) return;
      html += '<div class="pg"><h5>' + esc(g.title) + '</h5><div class="pg-items">' + items.map(function (i) {
        return '<button class="pi' + (i.ticker === selected ? ' cur' : '') + '" role="option" data-t="' + esc(i.ticker) + '"><b>' + esc(i.ticker) + '</b><small>' + esc(i.name) + '</small></button>';
      }).join('') + '</div></div>';
    });
    var raw = String(q || '').trim().toUpperCase().replace(/\.SA$/, '');
    var known = flatUniverse().some(function (i) { return i.ticker === raw; });
    if (raw && /^[A-Z0-9]{2,8}$/.test(raw) && !known) {
      var custom = '<div class="pg"><h5>Buscar ticker fora da lista</h5><div class="pg-items"><button class="pi custom" data-t="' + esc(raw) + '" data-custom="1"><b>' + esc(raw) + '</b><small>analisar este ativo</small></button></div></div>';
      // Código B3 completo (ex.: TAEE11) vem primeiro; texto parcial (ex.: "bova") deixa os resultados da lista na frente.
      html = /^[A-Z]{4}(3|4|5|6|11|32|33|34|35)$/.test(raw) || !html ? custom + html : html + custom;
    }
    $('pickerList').innerHTML = html || '<p class="dim small">Nada encontrado. Digite o código completo (ex.: ABCD3) para buscar.</p>';
    $('pickerList').querySelectorAll('.pi').forEach(function (b) { b.addEventListener('click', function () { choose(b.dataset.t, b.dataset.custom === '1'); }); });
  }
  function openPicker(open) {
    $('pickerPanel').hidden = !open;
    $('pickerBtn').setAttribute('aria-expanded', String(open));
    if (open) { $('pickerSearch').value = ''; renderPicker(''); setTimeout(function () { $('pickerSearch').focus(); }, 0); }
  }
  $('pickerBtn').addEventListener('click', function (e) { e.stopPropagation(); openPicker($('pickerPanel').hidden); });
  $('pickerSearch').addEventListener('input', function () { renderPicker(this.value); });
  $('pickerSearch').addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { openPicker(false); $('pickerBtn').focus(); }
    if (e.key === 'Enter') { var first = $('pickerList').querySelector('.pi'); if (first) first.click(); }
  });
  document.addEventListener('click', function (e) { if (!$('pickerPanel').hidden && !e.target.closest('.picker')) openPicker(false); });
  function choose(t, custom) {
    openPicker(false);
    if (custom) {
      $('pickerCur').textContent = t + '…';
      api('/api/lookup/' + encodeURIComponent(t)).then(function (r) { selectTicker(r.ticker); }).catch(function (e) { $('pickerCur').textContent = selected; toast(e.message); });
    } else selectTicker(t);
  }
  function renderRecent() {
    $('recent').innerHTML = recent.slice(0, 8).map(function (t) { return '<button data-t="' + esc(t) + '" aria-current="' + (t === selected) + '">' + esc(t) + '</button>'; }).join('');
    $('recent').querySelectorAll('button').forEach(function (b) { b.addEventListener('click', function () { selectTicker(b.dataset.t); }); });
  }
  function selectTicker(t, thenGenerate) {
    selected = t; store.set('ticker', t);
    recent = [t].concat(recent.filter(function (x) { return x !== t; })).slice(0, 8); store.set('recent', recent);
    $('pickerCur').textContent = t;
    renderRecent();
    $('opOut').hidden = true; $('opEmpty').hidden = false;
    $('opEmpty').innerHTML = 'Clique em <b>Gerar operação</b> para analisar ' + esc(t) + '.';
    var p = loadAsset(t);
    if (thenGenerate && p) p.then(function () { if (selected === t) generate(); });
  }

  function loadAsset(t) {
    $('aTitle').textContent = t; $('aPrice').textContent = '…'; $('aChg').textContent = '';
    return api('/api/asset/' + encodeURIComponent(t)).then(function (a) {
      if (a.ticker !== selected) return; // anti-erro: descarta resposta de ativo que não está mais selecionado
      $('aTitle').textContent = a.ticker + ' · ' + a.name;
      var cur = a.market === 'US' ? 'US$ ' : 'R$ ';
      $('aPrice').textContent = cur + n(a.quote.price);
      $('aChg').textContent = pct(a.quote.chg); $('aChg').className = 'num ' + sgn(a.quote.chg);
      if (chart) {
        var c = a.candles.slice(-400);
        candleS.setData(c.map(function (x) { return { time: x.time, open: x.open, high: x.high, low: x.low, close: x.close }; }));
        volS.setData(c.map(function (x) { return { time: x.time, value: x.volume, color: x.close >= x.open ? 'rgba(47,212,127,.28)' : 'rgba(255,93,93,.28)' }; }));
        var from = c.length ? c[0].time : 0;
        var cut = function (s) { return s.filter(function (p) { return p.time >= from; }); };
        if (a.ta.ok) { e8S.setData(cut(a.ta.series.e8)); e20S.setData(cut(a.ta.series.e20)); s200S.setData(cut(a.ta.series.s200)); }
        priceLines.forEach(function (pl) { candleS.removePriceLine(pl); }); priceLines = [];
        if (a.ta.ok) {
          a.ta.supports.slice(0, 2).forEach(function (s, i) { priceLines.push(candleS.createPriceLine({ price: s.price, color: 'rgba(47,212,127,.7)', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'S' + (i + 1) })); });
          a.ta.resistances.slice(0, 2).forEach(function (s, i) { priceLines.push(candleS.createPriceLine({ price: s.price, color: 'rgba(255,93,93,.7)', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'R' + (i + 1) })); });
          priceLines.push(candleS.createPriceLine({ price: a.ta.hi52, color: 'rgba(138,155,176,.45)', lineWidth: 1, lineStyle: 3, axisLabelVisible: false, title: 'Máx 52s' }));
          priceLines.push(candleS.createPriceLine({ price: a.ta.lo52, color: 'rgba(138,155,176,.45)', lineWidth: 1, lineStyle: 3, axisLabelVisible: false, title: 'Mín 52s' }));
        }
        chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, c.length - 160), to: c.length + 3 });
      }
      renderTA(a);
    }).catch(function (e) { toast(e.message); });
  }

  function renderTA(a) {
    var t = a.ta;
    if (!t.ok) { $('taDiag').innerHTML = '<li>' + esc(t.error) + '</li>'; return; }
    $('taTrend').textContent = t.trend.toUpperCase(); $('taTrend').className = 'tag ' + (t.score >= 15 ? 'up' : t.score <= -15 ? 'down' : '');
    var w = Math.abs(t.score) / 2;
    $('taBar').style.cssText = (t.score >= 0 ? 'left:50%;' : 'right:50%;') + 'width:' + w + '%;background:' + (t.score >= 0 ? 'rgba(47,212,127,.45)' : 'rgba(255,93,93,.45)');
    $('taScore').textContent = 'Pontuação técnica ' + (t.score > 0 ? '+' : '') + Math.round(t.score);
    $('taKpis').innerHTML = kpi('IFR 14', n(t.rsi, 0), t.rsi > 70 ? 'sobrecomprado' : t.rsi < 30 ? 'sobrevendido' : 'neutro') + kpi('ATR 14', n(t.atr), n(t.atr / t.price * 100, 1) + '% do preço') + kpi('Vol. hist. 20d', n(t.hv20 * 100, 1) + '%', 'percentil ' + n(t.hvPct, 0));
    $('taDiag').innerHTML = t.diagnosis.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('');
    renderAudit(a);
    $('taParts').innerHTML = t.parts.map(function (p) { return '<li><span>' + esc(p.why) + '</span><span class="num ' + sgn(p.val) + '">' + (p.val > 0 ? '+' : '') + n(p.val, 0) + '</span></li>'; }).join('');
  }

  function renderAudit(a) {
    var c = a.calib, v = a.audit || {};
    if (!c || !c.ok) { $('taAudit').innerHTML = '<p class="dim small">' + esc((c && c.reason) || 'Auditoria indisponível.') + '</p>'; return; }
    var cls = { edge: 'up', contrary: 'down', noedge: 'neu', unknown: 'neu', neutral: '' }[v.status] || '';
    var lbl = { edge: 'SINAL COM VANTAGEM', contrary: 'SINAL HISTORICAMENTE CONTRÁRIO', noedge: 'SINAL SEM VANTAGEM', unknown: 'AMOSTRA INSUFICIENTE', neutral: 'LATERAL' }[v.status] || '';
    var cur = v.bucket ? v.bucket.id : null;
    var rows = c.buckets.map(function (b) {
      var hit = b.hit != null ? n(b.hit * 100, 0) + '%' : '—';
      var base = b.base != null ? n(b.base * 100, 0) + '%' : '—';
      var z = b.z != null ? n(b.z, 1) : '—';
      return '<tr class="' + (b.id === cur ? 'cur' : '') + '"><td>' + esc(b.label) + '</td><td class="r num">' + b.n + '</td><td class="r num">' + hit + '</td><td class="r num dim">' + base + '</td><td class="r num ' + sgn(b.avgFwd) + '">' + pct(b.avgFwd) + '</td><td class="r num">' + z + '</td></tr>';
    }).join('');
    $('taAudit').innerHTML = '<span class="flag ' + cls + '">' + lbl + '</span><p class="small" style="margin:8px 0">' + esc(v.msg || '') + '</p><table class="tbl"><thead><tr><th>Faixa</th><th class="r">Ocorr.</th><th class="r">Acerto</th><th class="r">Base</th><th class="r">Ret. médio</th><th class="r">z</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  // ---------------- operação ----------------
  var lastOp = null;
  $('gen').addEventListener('click', generate);
  function generate() {
    var cap = parseFloat(String($('capital').value).replace(/\./g, '').replace(',', '.'));
    var risk = parseFloat(String($('risk').value).replace(',', '.'));
    store.set('capital', $('capital').value); store.set('risk', $('risk').value);
    var b = $('gen'); b.disabled = true; b.textContent = 'Analisando…';
    $('opEmpty').hidden = false; $('opEmpty').innerHTML = '<div class="skel" style="height:18px;width:60%"></div><div class="skel" style="height:14px;width:85%;margin-top:10px"></div><div class="skel" style="height:14px;width:40%;margin-top:10px"></div>';
    var qs = '?capital=' + (isFinite(cap) ? cap : '') + '&risk=' + (isFinite(risk) ? risk : '');
    var asked = selected;
    api('/api/operation/' + encodeURIComponent(asked) + qs).then(function (o) { if (o.ticker !== selected) return; lastOp = o; renderOp(o); })
      .catch(function (e) { $('opEmpty').textContent = 'Não foi possível gerar a análise: ' + e.message; })
      .finally(function () { b.disabled = false; b.textContent = 'Gerar operação'; });
  }

  function renderOp(o) {
    $('opEmpty').hidden = true; $('opOut').hidden = false;
    var cur = o.market === 'US' ? 'US$' : 'R$';
    var d = o.decision;
    var best = o.best;
    var badges = ['Viés ' + (o.dir.bias > 0 ? '+' : '') + o.dir.bias + ' (' + o.dir.label + ')', 'Confiança ' + o.dir.confidence + '/100', 'Opções ' + o.vol.label];
    if (d.needsBookCheck) badges.push('Preços teóricos — confirmar no book');
    if (o.regime.stress) badges.push('Mercado em estresse');
    $('verdict').className = 'verdict ' + d.level;
    $('verdict').innerHTML = '<div class="vh">' + esc(d.headline) + '</div>' + (d.summary ? '<p class="vs">' + esc(d.summary) + '</p>' : '') + '<div class="vb">' + badges.map(function (b) { return '<span>' + esc(b) + '</span>'; }).join('') + '</div>';
    $('notWorth').innerHTML = (o.notWorth || []).map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('');
    $('plain').innerHTML = (o.plain || []).map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('');
    $('triggers').innerHTML = (o.triggers || []).map(function (t) { return '<li>' + esc(t.text) + '</li>'; }).join('') || '<li class="dim">Sem gatilhos relevantes no momento.</li>';

    $('dirBias').textContent = (o.dir.bias > 0 ? '+' : '') + o.dir.bias; $('dirBias').className = 'num big ' + sgn(o.dir.bias);
    $('dirLbl').textContent = o.dir.label + ' · confiança ' + o.dir.confidence + '/100';
    $('dirComps').innerHTML = o.dir.comps.map(function (c) {
      var w = Math.min(50, Math.abs(c.score) / 2);
      var st = c.score >= 0 ? 'left:50%;width:' + w + '%;background:' + C_UP : 'right:50%;width:' + w + '%;background:' + C_DN;
      return '<li><span class="lbl" title="' + esc(c.label) + '">' + esc(c.label) + '</span><span class="bar"><i style="' + st + '"></i></span><span class="v num ' + sgn(c.score) + '">' + Math.round(c.score) + '</span></li>';
    }).join('');
    $('volIv').textContent = 'VI ' + n(o.vol.atmIv * 100, 1) + '%';
    $('volLbl').textContent = o.vol.ivReal ? 'Opções ' + o.vol.label + ' frente à vol. prevista' : 'VI estimada (sem grade real)';
    $('volKpis').innerHTML = kpi('Vol. prevista', n(o.vol.forecast * 100, 1) + '%', 'EWMA ' + n(o.vol.ewma * 100, 1) + '% · 1 ano ' + n(o.vol.hv252 * 100, 1) + '%') + kpi('VI / prevista', o.vol.ratio ? n(o.vol.ratio, 2) + 'x' : '—') + kpi('Vol. hist. 20d', n(o.vol.hv20 * 100, 1) + '%', 'percentil ' + n(o.vol.hvPct, 0)) + kpi('IV Rank', o.vol.ivRank != null ? n(o.vol.ivRank, 0) : 'em formação');
    $('chainSrc').innerHTML = '<div class="tag ' + (o.chain.real ? 'up' : '') + '">' + esc(o.chain.source) + '</div><p class="muted small" style="margin:8px 0 0">' + (o.chain.real ? 'Grade real com bid/ask, volume e contratos em aberto.' : 'Sem grade real conectada: strikes e prêmios são <b>teóricos</b> (' + esc(o.chain.volMethod || '') + '). Use como mapa e confirme no book.') + '</p>' + (o.chain.providerErrors.length ? '<p class="small down">' + esc(o.chain.providerErrors.join(' · ')) + '</p>' : '') + '<p class="dim small" style="margin:6px 0 0">Juros ' + n(o.inputs.r * 100) + '% · dividend yield ' + n(o.inputs.q * 100, 1) + '%</p>';

    $('bestWrap').hidden = !best;
    if (best) {
      $('roleTitle').textContent = d.role || 'Operação';
      var ws = $('warnStrip');
      if (d.level === 'nao_vale') { ws.hidden = false; ws.textContent = 'O sistema não vê vantagem estatística agora. Esta é a estrutura de menor dano esperado entre as aprovadas na camada anti-erro, com risco definido e tamanho reduzido a 1/3. Opere apenas se tiver um motivo próprio.'; }
      else if (d.level === 'reduzido') { ws.hidden = false; ws.textContent = 'Vantagem existe, mas com ressalvas (veja "Por que esta decisão"): o tamanho sugerido já está pela metade.'; }
      else ws.hidden = true;
      $('bestName').textContent = best.name;
      $('bestScore').textContent = 'nota ' + best.score + '/100';
      $('legs').querySelector('tbody').innerHTML = best.legs.map(function (l) {
        var ser = l.theoretical ? (l.seriesHint ? '<br><span class="dim small">' + esc(l.seriesHint) + ' (confirmar)</span>' : '') : '<br><span class="dim small">' + esc(l.symbol) + '</span>';
        return '<tr><td class="' + (l.side > 0 ? 'buy' : 'sell') + '">' + (l.side > 0 ? 'COMPRA' : 'VENDA') + '</td><td>' + l.type.toUpperCase() + ser + '</td><td class="r num">' + n(l.strike) + '</td><td class="num">' + esc(l.expiry.split('-').reverse().join('/')) + ' <span class="dim">(' + l.dte + 'd)</span></td><td class="r num">' + n(l.mid) + '</td><td class="r num">' + n(l.delta) + '</td><td class="r num">' + n(l.theta, 3) + '</td><td class="r num">' + n(l.vega, 3) + '</td><td class="r num">' + n(l.iv * 100, 1) + '%</td></tr>';
      }).join('');
      var L = best.lot * (best.fx || 1);
      var maxP = best.unlimitedGain ? 'ilimitado' : money(best.maxProfit * L, 'R$');
      var maxL = best.unlimitedLoss ? '−ilimitado' : money(best.maxLoss * L, 'R$');
      $('bestKpis').innerHTML =
        kpi(best.debit ? 'Débito líquido' : 'Crédito líquido', n(Math.abs(best.cost)), money(Math.abs(best.cost) * L, 'R$') + ' por lote') +
        kpi('Ganho esperado', money(best.evPhys * L, 'R$'), (best.ror != null ? pct(best.ror * 100, 1) : '—') + ' do risco · por lote', best.evPhys >= 0 ? 'up' : 'down') +
        kpi('Ganho máximo', maxP, 'por lote', 'up') +
        kpi('Perda máxima', maxL, 'por lote', 'down') +
        kpi('Prob. de lucro', n(best.popPhys * 100, 0) + '%', 'cenário calibrado · mercado ' + n(best.pop * 100, 0) + '%') +
        kpi('Ponto(s) de equilíbrio', best.breakevens.map(function (x) { return n(x); }).join(' · ') || '—', 'spot ' + n(o.S)) +
        kpi('Delta da posição', n(best.greeks.delta), 'Θ ' + n(best.greeks.theta, 3) + '/dia · Vega ' + n(best.greeks.vega, 3)) +
        kpi('Tamanho sugerido', best.lots + ' lote(s)', (best.sizeFactor < 1 ? 'reduzido de ' + best.lotsFull + ' · ' : '') + 'risco ≈ R$ ' + n(best.lots * best.riskPerLot, 0));
      drawPayoff(best, o.S, cur);
      $('exec').innerHTML = o.execution.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('');
      $('exec').hidden = true; $('execBtn').textContent = 'Como executar esta estratégia';
      $('saveBtn').textContent = d.level === 'nao_vale' ? 'Registrar no diário (contra a recomendação)' : 'Registrar no diário';
      $('saveMsg').textContent = '';
    }

    if (o.ai) { $('ai').hidden = false; $('ai').textContent = o.ai; } else $('ai').hidden = true;
    $('why').innerHTML = o.rationale.map(function (p) { return '<section><h5>' + esc(p.h) + '</h5><p>' + esc(p.t) + '</p></section>'; }).join('');

    var checks = o.contextChecks.concat(best ? best.guard.checks : []);
    var grp = {};
    checks.forEach(function (c) { (grp[c.group] = grp[c.group] || []).push(c); });
    var order = ['Dados', 'Cálculo', 'Mercado', 'Risco', 'Gestão'];
    var ic = { ok: '✓', warn: '!', block: '✕' };
    var tot = { ok: 0, warn: 0, block: 0 }; checks.forEach(function (c) { tot[c.status]++; });
    $('checks').innerHTML = '<div class="kpis kpis-3" style="margin:0">' + kpi('Aprovadas', tot.ok, '', 'up') + kpi('Alertas', tot.warn, '') + kpi('Bloqueios', tot.block, '', tot.block ? 'down' : '') + '</div>' +
      order.filter(function (g) { return grp[g]; }).map(function (g) {
        return '<div class="chk-g"><h5>' + esc(g) + '</h5>' + grp[g].sort(function (a, b) { var r = { block: 0, warn: 1, ok: 2 }; return r[a.status] - r[b.status]; }).map(function (c) { return '<div class="chk ' + c.status + '"><span class="ic">' + ic[c.status] + '</span><div><b>' + esc(c.label) + '</b><span>' + esc(c.detail) + '</span></div></div>'; }).join('') + '</div>';
      }).join('');

    var alts = (o.alternatives || []).map(function (a) { return { a: a, blk: false }; }).concat((o.rejected || []).map(function (a) { return { a: a, blk: true }; }));
    $('alts').innerHTML = alts.map(function (x) {
      var a = x.a, LL = a.lot * (a.fx || 1);
      var info = x.blk ? '<span class="down">Bloqueada:</span> ' + esc(a.guard.blocks.join(' · ')) : 'Ganho esperado ' + money(a.evPhys * LL, 'R$') + ' (' + (a.ror != null ? pct(a.ror * 100, 1) : '—') + ' do risco) · prob. lucro ' + n(a.popPhys * 100, 0) + '% · perda máx. ' + (a.unlimitedLoss ? 'ilimitada' : money(a.maxLoss * LL, 'R$'));
      return '<div class="alt ' + (x.blk ? 'blk' : '') + '"><h6><span>' + esc(a.name) + '</span><span class="num dim">' + a.score + '</span></h6><p>' + info + '</p></div>';
    }).join('') || '<div class="dim">Nenhuma outra estrutura gerada.</div>';
  }

  $('execBtn').addEventListener('click', function () {
    var e = $('exec'); e.hidden = !e.hidden;
    this.textContent = e.hidden ? 'Como executar esta estratégia' : 'Ocultar passo a passo';
    if (!e.hidden) e.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  $('saveBtn').addEventListener('click', function () {
    if (!lastOp || !lastOp.best) return;
    var b = lastOp.best;
    api('/api/journal', { method: 'POST', body: { ticker: lastOp.ticker, name: b.name, decision: lastOp.decision.label, score: b.score, spot: lastOp.S, lots: b.lots, legs: b.legs, r: lastOp.inputs.r, q: lastOp.inputs.q } })
      .then(function () { $('saveMsg').textContent = 'Registrado no diário ✓'; })
      .catch(function (e) { $('saveMsg').textContent = e.message; });
  });

  function drawPayoff(best, S, cur) {
    var svg = $('payoff');
    var W = 560, H = 260, pl = 58, pr = 12, pt = 12, pb = 28;
    var pts = best.payoff.filter(function (p) { return p.s >= S * 0.7 && p.s <= S * 1.3; });
    if (!pts.length) { svg.innerHTML = ''; return; }
    var xs = pts.map(function (p) { return p.s; });
    var ys = pts.map(function (p) { return p.exp; }).concat(pts.map(function (p) { return p.now; }));
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    var y0 = Math.min.apply(null, ys.concat([0])), y1 = Math.max.apply(null, ys.concat([0]));
    var pad = (y1 - y0) * 0.08 || 1; y0 -= pad; y1 += pad;
    var X = function (v) { return pl + (v - x0) / (x1 - x0) * (W - pl - pr); };
    var Y = function (v) { return pt + (1 - (v - y0) / (y1 - y0)) * (H - pt - pb); };
    var path = function (k) { return pts.map(function (p, i) { return (i ? 'L' : 'M') + X(p.s).toFixed(1) + ',' + Y(p[k]).toFixed(1); }).join(''); };
    var area = 'M' + X(pts[0].s).toFixed(1) + ',' + Y(0).toFixed(1) + pts.map(function (p) { return 'L' + X(p.s).toFixed(1) + ',' + Y(p.exp).toFixed(1); }).join('') + 'L' + X(pts[pts.length - 1].s).toFixed(1) + ',' + Y(0).toFixed(1) + 'Z';
    var ticksY = [y0 + (y1 - y0) * 0.1, (y0 + y1) / 2, y1 - (y1 - y0) * 0.1, 0];
    var ticksX = [x0, (x0 + S) / 2, S, (S + x1) / 2, x1];
    var g = '';
    g += '<defs><clipPath id="cUp"><rect x="0" y="0" width="' + W + '" height="' + Y(0) + '"/></clipPath><clipPath id="cDn"><rect x="0" y="' + Y(0) + '" width="' + W + '" height="' + (H - Y(0)) + '"/></clipPath></defs>';
    ticksY.forEach(function (v) { g += '<line x1="' + pl + '" x2="' + (W - pr) + '" y1="' + Y(v) + '" y2="' + Y(v) + '" stroke="' + (v === 0 ? '#3a4d63' : '#1d2a38') + '" stroke-width="1"/><text x="' + (pl - 6) + '" y="' + (Y(v) + 4) + '" fill="#8a9bb0" font-size="10" text-anchor="end" font-family="ui-monospace,monospace">' + esc(n(v, 0)) + '</text>'; });
    ticksX.forEach(function (v) { g += '<text x="' + X(v) + '" y="' + (H - 8) + '" fill="#8a9bb0" font-size="10" text-anchor="middle" font-family="ui-monospace,monospace">' + esc(n(v)) + '</text>'; });
    g += '<path d="' + area + '" fill="rgba(47,212,127,.16)" clip-path="url(#cUp)"/><path d="' + area + '" fill="rgba(255,93,93,.16)" clip-path="url(#cDn)"/>';
    g += '<path d="' + path('now') + '" fill="none" stroke="#5aa9ff" stroke-width="1.6" stroke-dasharray="5 4"/>';
    g += '<path d="' + path('exp') + '" fill="none" stroke="#f5b83d" stroke-width="2.4"/>';
    g += '<line x1="' + X(S) + '" x2="' + X(S) + '" y1="' + pt + '" y2="' + (H - pb) + '" stroke="#e7edf4" stroke-opacity=".5" stroke-dasharray="2 3"/><text x="' + (X(S) + 4) + '" y="' + (pt + 10) + '" fill="#e7edf4" font-size="10">spot</text>';
    (best.breakevens || []).forEach(function (be) { if (be >= x0 && be <= x1) g += '<circle cx="' + X(be) + '" cy="' + Y(0) + '" r="3.5" fill="#e7edf4"/>'; });
    svg.innerHTML = g;
  }

  // ---------------- diário ----------------
  function loadJournal() {
    api('/api/journal').then(function (j) {
      var s = j.stats;
      $('jStats').innerHTML = kpi('Registros', s.total) + kpi('Encerradas/vencidas', s.closed) + kpi('Taxa de acerto', s.winRate != null ? n(s.winRate, 0) + '%' : '—', s.closed < 20 ? 'amostra pequena: ainda sem significância' : '') + kpi('Resultado (fech. + aberto)', n(s.pnlClosed + s.pnlOpen), 'fechado ' + n(s.pnlClosed) + ' · aberto ' + n(s.pnlOpen), sgn(s.pnlClosed + s.pnlOpen));
      $('jTbl').querySelector('tbody').innerHTML = j.entries.map(function (e) {
        var pnl = e.status === 'encerrada' ? e.finalPnl : e.mtm ? e.mtm.pnl : null;
        var legs = e.legs.map(function (l) { return (l.side > 0 ? '+' : '−') + l.type[0].toUpperCase() + ' ' + n(l.strike); }).join(' / ');
        return '<tr><td class="num">' + esc(new Date(e.createdAt).toLocaleDateString('pt-BR')) + '</td><td><b>' + esc(e.ticker) + '</b></td><td>' + esc(e.name) + '<br><span class="dim small">' + esc(legs) + '</span></td><td class="r num">' + e.lots + '</td><td class="r num">' + n(e.cost) + '</td><td class="r num">' + n(e.spot) + ' → ' + (e.mtm ? n(e.mtm.S) : '—') + '</td><td class="r num ' + sgn(pnl) + '">' + (pnl != null ? esc(e.currency || 'R$') + ' ' + n(pnl) : '—') + (e.mtm && e.mtm.pnlPct != null && e.status !== 'encerrada' ? '<br><span class="small">' + pct(e.mtm.pnlPct, 0) + '</span>' : '') + '</td><td><span class="st">' + esc(e.mtm && e.mtm.expired ? 'vencida' : e.status) + '</span></td><td>' + (e.status === 'aberta' ? '<button class="lnk" data-close="' + esc(e.id) + '">encerrar</button>' : '') + '<button class="lnk" data-del="' + esc(e.id) + '">excluir</button></td></tr>';
      }).join('') || '<tr><td colspan="9" class="dim">Nenhuma operação registrada. Gere uma operação e clique em “Registrar no diário”.</td></tr>';
      $('jTbl').querySelectorAll('[data-del]').forEach(function (b) { b.addEventListener('click', function () { if (confirm('Excluir este registro?')) api('/api/journal/' + b.dataset.del, { method: 'DELETE' }).then(loadJournal); }); });
      $('jTbl').querySelectorAll('[data-close]').forEach(function (b) { b.addEventListener('click', function () { if (confirm('Encerrar pela marcação atual?')) api('/api/journal/' + b.dataset.close + '/close', { method: 'POST' }).then(loadJournal); }); });
    }).catch(function (e) { toast(e.message); });
  }

  // ---------------- oportunidades (scanner) ----------------
  var scanRows = [], scanLevel = store.get('scanLevel', 'todas'), scanSort = { k: null, dir: 1 }, scanTimer = null;
  var LV = { operar: 'Operar', reduzido: 'Reduzido', nao_vale: 'Não vale a pena', bloqueado: 'Bloqueado' };
  var LVO = { operar: 0, reduzido: 1, nao_vale: 2, bloqueado: 3 };
  function loadScanner() {
    api('/api/scanner').then(function (s) {
      scanRows = s.rows || [];
      var prog = s.total ? Math.round(s.done / s.total * 100) : 0;
      $('scanStatus').innerHTML = s.running ? 'varrendo ' + s.done + '/' + s.total + ' ativos…' : (s.finishedAt ? 'atualizado ' + ago(s.finishedAt) + ' · próxima varredura automática em até 15 min' : 'primeira varredura ainda não concluída');
      var c = { operar: 0, reduzido: 0, nao_vale: 0, bloqueado: 0 };
      scanRows.forEach(function (r) { if (!r.error && c[r.level] != null) c[r.level]++; });
      $('scanKpis').innerHTML = (s.running ? '<div class="progress" style="grid-column:1/-1"><i style="width:' + prog + '%"></i></div>' : '') + kpi('Operar', c.operar, 'vantagem clara', 'up') + kpi('Operar reduzido', c.reduzido, 'vantagem com ressalvas') + kpi('Não vale a pena', c.nao_vale, 'com alternativa indicada') + kpi('Bloqueados', c.bloqueado, 'dados ou risco', c.bloqueado ? 'down' : '');
      var sel = $('scanGroup'), curG = sel.value;
      var gs = []; scanRows.forEach(function (r) { if (r.group && gs.indexOf(r.group) < 0) gs.push(r.group); });
      sel.innerHTML = '<option value="">Todos os setores</option>' + gs.map(function (g) { return '<option' + (g === curG ? ' selected' : '') + '>' + esc(g) + '</option>'; }).join('');
      renderScan();
      clearTimeout(scanTimer);
      if (s.running && current === 'scanner') scanTimer = setTimeout(loadScanner, 4000);
    }).catch(function (e) { $('scanStatus').textContent = e.message; });
  }
  function renderScan() {
    $('scanLevels').innerHTML = ['todas', 'operar', 'reduzido', 'nao_vale', 'bloqueado'].map(function (k) { return '<button data-k="' + k + '" aria-pressed="' + (k === scanLevel) + '">' + (k === 'todas' ? 'Todas' : LV[k]) + '</button>'; }).join('');
    $('scanLevels').querySelectorAll('button').forEach(function (b) { b.addEventListener('click', function () { scanLevel = b.dataset.k; store.set('scanLevel', scanLevel); renderScan(); }); });
    var g = $('scanGroup').value, q = norm($('scanSearch').value);
    var rows = scanRows.filter(function (r) {
      if (g && r.group !== g) return false;
      if (q && norm(r.ticker + ' ' + r.name).indexOf(q) < 0) return false;
      if (scanLevel !== 'todas' && (r.error ? 'bloqueado' : r.level) !== scanLevel) return false;
      return true;
    });
    if (scanSort.k) rows = rows.slice().sort(function (a, b) {
      var k = scanSort.k, va = k === 'level' ? LVO[a.level] : a[k], vb = k === 'level' ? LVO[b.level] : b[k];
      if (va == null) return 1; if (vb == null) return -1;
      return (va > vb ? 1 : va < vb ? -1 : 0) * scanSort.dir;
    });
    var badgeAudit = function (st, kind) {
      var map = kind === 'tech' ? { edge: ['funciona', 'ok'], contrary: ['reverte', 'bad'], noedge: ['sem vantagem', 'neu'], neutral: ['lateral', 'neu'], unknown: ['amostra curta', 'neu'] } : { bull: ['favorável', 'ok'], bear: ['desfavorável', 'bad'], noedge: ['neutro', 'neu'], unknown: ['sem dado', 'neu'] };
      var x = map[st] || ['—', 'neu']; return '<span class="bd ' + x[1] + '">' + x[0] + '</span>';
    };
    $('scanTbl').querySelector('tbody').innerHTML = rows.map(function (r) {
      if (r.error) return '<tr data-t="' + esc(r.ticker) + '"><td><b>' + esc(r.ticker) + '</b><small>' + esc(r.name || '') + '</small></td><td colspan="11"><span class="bd err">erro</span> <span class="dim small">' + esc(r.error) + '</span></td></tr>';
      return '<tr data-t="' + esc(r.ticker) + '">' +
        '<td><b>' + esc(r.ticker) + '</b><small>' + esc(r.name) + ' · ' + esc(r.group) + '</small></td>' +
        '<td class="r num">' + n(r.price) + '<small class="' + sgn(r.chg) + '">' + pct(r.chg) + '</small></td>' +
        '<td><span class="num ' + sgn(r.techScore) + '">' + (r.techScore > 0 ? '+' : '') + n(r.techScore, 0) + '</span> ' + badgeAudit(r.techStatus, 'tech') + '</td>' +
        '<td>' + badgeAudit(r.macroStatus, 'macro') + '</td>' +
        '<td class="small">' + esc(r.volLabel) + (r.ivRatio && r.volLabel !== 'estimada' ? ' <span class="dim">' + n(r.ivRatio, 2) + 'x</span>' : '') + '</td>' +
        '<td class="r num"><span class="' + sgn(r.bias) + '">' + (r.bias > 0 ? '+' : '') + r.bias + '</span> <span class="dim">· ' + r.confidence + '</span></td>' +
        '<td><span class="bd ' + r.level + '">' + esc(LV[r.level] || r.level) + '</span></td>' +
        '<td class="small">' + esc(r.strategy || '—') + '</td>' +
        '<td class="r num">' + (r.score != null ? r.score : '—') + '</td>' +
        '<td class="r num ' + sgn(r.ror) + '">' + (r.ror != null ? pct(r.ror * 100, 1) : '—') + '</td>' +
        '<td class="r num">' + (r.popPhys != null ? n(r.popPhys * 100, 0) + '%' : '—') + '</td></tr>';
    }).join('') || '<tr><td colspan="11" class="dim">' + (scanRows.length ? 'Nenhum ativo neste filtro.' : 'A primeira varredura começa alguns segundos após o servidor iniciar e leva 1–2 minutos.') + '</td></tr>';
    $('scanTbl').querySelectorAll('tbody tr[data-t]').forEach(function (tr) { tr.addEventListener('click', function () { showTab('analysis'); selectTicker(tr.dataset.t, true); }); });
  }
  $('scanTbl').querySelectorAll('th[data-k]').forEach(function (th) { th.addEventListener('click', function () { var k = th.dataset.k; scanSort = { k: k, dir: scanSort.k === k ? -scanSort.dir : (['ticker', 'group', 'level', 'strategy', 'volLabel', 'macroStatus'].indexOf(k) >= 0 ? 1 : -1) }; renderScan(); }); });
  $('scanGroup').addEventListener('change', renderScan);
  $('scanSearch').addEventListener('input', renderScan);
  $('scanRefresh').addEventListener('click', function () { api('/api/scanner/refresh', { method: 'POST' }).then(function () { toast('Varredura iniciada.'); setTimeout(loadScanner, 800); }); });

  // ---------------- início ----------------
  api('/api/universe').then(function (u) {
    groups = u.groups;
    $('capital').value = store.get('capital', String(u.risk.capital));
    $('risk').value = store.get('risk', String(u.risk.maxRiskPct));
    $('pickerCur').textContent = selected;
    renderRecent();
    showTab(store.get('tab', 'overview'));
  });
  loadMacro(); loadFlow();
  setInterval(function () { if (!document.hidden) loadMacro(); }, 60000);
  setInterval(function () { if (!document.hidden) loadFlow(); }, 180000);
})();
