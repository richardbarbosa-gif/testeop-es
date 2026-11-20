'use strict';
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const { config, assertSecure } = require('./src/config');
const auth = require('./src/lib/auth');
const market = require('./src/market');

const problems = assertSecure();
if (problems.length) {
  // Falha fechada: sem credenciais configuradas o sistema NÃO sobe aberto.
  console.error('[segurança] Configuração incompleta:\n - ' + problems.join('\n - '));
  console.error('Configure as variáveis de ambiente (veja .env.example) e reinicie.');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Hostinger serve atrás de proxy reverso (HTTPS)

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:'],
      'connect-src': ["'self'"],
      'font-src': ["'self'"],
      'frame-ancestors': ["'none'"],
      'form-action': ["'self'"],
      'base-uri': ["'none'"],
      'object-src': ["'none'"],
      'upgrade-insecure-requests': config.isProd ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'no-referrer' },
  hsts: config.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
}));
app.use(compression());
app.use(express.json({ limit: '64kb' }));

// Robôs de busca: nada a indexar.
app.get('/robots.txt', (_req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

const PUB = path.join(__dirname, 'public');
const noStore = (res) => res.set('Cache-Control', 'no-store');

// ---------- Rotas públicas ----------
app.get('/login', (req, res) => {
  if (auth.readSession(req)) return res.redirect('/');
  noStore(res);
  res.sendFile(path.join(PUB, 'login.html'));
});
app.use('/assets', express.static(path.join(PUB, 'assets'), { maxAge: '1h', index: false }));
app.post('/api/login', auth.csrfGuard, auth.login);
app.get('/api/auth-info', (_req, res) => res.json({ totp: Boolean(config.auth.totpSecret) }));

// ---------- Rotas autenticadas ----------
app.use(auth.requireAuth);
app.use(auth.csrfGuard);
app.post('/api/logout', (_req, res) => { auth.clearSession(res); res.json({ ok: true }); });
app.use('/app', express.static(path.join(PUB, 'app'), { maxAge: '1h', index: false }));
app.get('/vendor/lightweight-charts.js', (_req, res) => {
  res.set('Cache-Control', 'private, max-age=86400');
  res.sendFile(path.join(__dirname, 'node_modules', 'lightweight-charts', 'dist', 'lightweight-charts.standalone.production.js'));
});
app.get('/', (_req, res) => { noStore(res); res.sendFile(path.join(PUB, 'index.html')); });

const TICKER = /^[A-Z0-9]{2,8}$/;
const wrap = (fn) => async (req, res) => {
  try {
    noStore(res);
    res.json(await fn(req));
  } catch (e) {
    const status = e.status || 502;
    if (status >= 500) console.error('[api]', req.path, e.message);
    res.status(status).json({ ok: false, error: status >= 500 ? 'Fonte de dados indisponível no momento. Tente novamente.' : e.message });
  }
};
const tickerOf = (req) => {
  const t = String(req.params.ticker || '').toUpperCase();
  if (!TICKER.test(t) || !market.resolve(t)) throw Object.assign(new Error('Ticker inválido. Use o código da B3 (ex.: PETR4) ou dos EUA (ex.: EWZ).'), { status: 400 });
  return t;
};

app.get('/api/universe', wrap(async () => ({ groups: market.GROUPS.map((g) => ({ id: g.id, title: g.title, items: g.items.map(([t, name]) => ({ ticker: t, name, market: market.UNDERLYINGS[t].market })) })), risk: config.risk, providers: { oplab: Boolean(config.providers.oplabToken), tradier: Boolean(config.providers.tradierToken), ai: Boolean(config.providers.anthropicKey) } })));
app.get('/api/macro', wrap(() => market.macro()));
app.get('/api/asset/:ticker', wrap((req) => market.asset(tickerOf(req))));
app.get('/api/lookup/:ticker', wrap((req) => market.lookup(tickerOf(req))));
app.get('/api/scanner', wrap(async () => market.scanState()));
app.post('/api/scanner/refresh', wrap(async () => { market.runScan().catch(() => {}); return { ok: true }; }));
app.get('/api/operation/:ticker', wrap((req) => market.operation(tickerOf(req), { capital: req.query.capital, riskPct: req.query.risk })));
app.get('/api/flow', wrap(() => market.flowRadar()));
app.get('/api/journal', wrap(() => market.journalView()));

app.post('/api/journal', wrap(async (req) => {
  const b = req.body || {};
  const t = String(b.ticker || '').toUpperCase();
  const ru = market.resolve(t);
  if (!ru) throw Object.assign(new Error('Ativo inválido.'), { status: 400 });
  if (!Array.isArray(b.legs) || !b.legs.length || b.legs.length > 4) throw Object.assign(new Error('Pernas inválidas.'), { status: 400 });
  const legs = b.legs.map((l) => {
    const leg = {
      type: l.type === 'call' ? 'call' : 'put',
      side: Number(l.side) > 0 ? 1 : -1,
      strike: Number(l.strike),
      expiry: String(l.expiry || '').slice(0, 10),
      mid: Number(l.mid),
      symbol: String(l.symbol || '').slice(0, 60),
      iv: Number(l.iv) >= 0.03 && Number(l.iv) <= 2.5 ? Number(l.iv) : null,
    };
    if (!(leg.strike > 0) || !(leg.mid >= 0) || !/^\d{4}-\d{2}-\d{2}$/.test(leg.expiry)) throw Object.assign(new Error('Perna inválida.'), { status: 400 });
    return leg;
  });
  return market.journal.add({
    ticker: t,
    name: String(b.name || '').slice(0, 80),
    decision: String(b.decision || '').slice(0, 20),
    score: Number(b.score) || null,
    spot: Number(b.spot) || null,
    cost: legs.reduce((a, l) => a + l.side * l.mid, 0),
    lots: Math.max(1, Math.min(1000, Math.floor(Number(b.lots) || 1))),
    lot: 100,
    currency: ru.market === 'US' ? 'US$' : 'R$',
    legs,
    note: String(b.note || '').slice(0, 500),
    r: Number(b.r) >= 0 && Number(b.r) < 1 ? Number(b.r) : null,
    q: Number(b.q) >= 0 && Number(b.q) < 0.3 ? Number(b.q) : 0,
  });
}));
app.post('/api/journal/:id/close', wrap(async (req) => {
  const id = String(req.params.id);
  const v = await market.journalView();
  const e = v.entries.find((x) => x.id === id);
  if (!e) throw Object.assign(new Error('Registro não encontrado.'), { status: 404 });
  return market.journal.update(id, { status: 'encerrada', closedAt: new Date().toISOString(), finalPnl: e.mtm ? e.mtm.pnl : 0 });
}));
app.delete('/api/journal/:id', wrap(async (req) => ({ ok: market.journal.remove(String(req.params.id)) })));

app.use((_req, res) => res.status(404).json({ ok: false, error: 'Não encontrado.' }));

app.listen(config.port, () => {
  console.log(`Radar de Opções em http://localhost:${config.port}`);
  if (process.env.SCANNER !== 'off') market.startScanner(); // varre todos os ativos em segundo plano (15 em 15 min)
});
