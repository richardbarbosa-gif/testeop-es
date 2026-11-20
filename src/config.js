'use strict';
// Configuração central. Segredos vêm SOMENTE de variáveis de ambiente
// (painel da Hostinger) ou de um arquivo .env local que nunca é commitado.
const fs = require('fs');
const path = require('path');

function loadDotEnv() {
  const file = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadDotEnv();

const env = process.env;
const isProd = env.NODE_ENV === 'production';

const config = {
  isProd,
  port: Number(env.PORT) || 3000,
  auth: {
    user: (env.APP_USER || '').trim().toLowerCase(),
    passHash: env.APP_PASS_HASH || '',
    sessionSecret: env.SESSION_SECRET || '',
    totpSecret: (env.TOTP_SECRET || '').replace(/\s+/g, '').toUpperCase(),
    sessionHours: Number(env.SESSION_HOURS) || 12,
  },
  providers: {
    oplabToken: env.OPLAB_TOKEN || '',
    tradierToken: env.TRADIER_TOKEN || '',
    tradierEnv: env.TRADIER_ENV === 'production' ? 'production' : 'sandbox',
    anthropicKey: env.ANTHROPIC_API_KEY || '',
    anthropicModel: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
  },
  risk: {
    capital: Number(env.RISK_CAPITAL) || 100000, // capital de referência (R$)
    maxRiskPct: Number(env.RISK_MAX_PCT) || 2, // risco máximo por operação (% do capital)
  },
  dataDir: env.DATA_DIR || path.join(__dirname, '..', 'data'),
};

function assertSecure() {
  const problems = [];
  if (!config.auth.user) problems.push('APP_USER ausente');
  if (!/^scrypt\$/.test(config.auth.passHash)) problems.push('APP_PASS_HASH ausente ou inválido (gere com: npm run hash)');
  if (config.auth.sessionSecret.length < 32) problems.push('SESSION_SECRET ausente ou curto (mínimo 32 caracteres)');
  return problems;
}

module.exports = { config, assertSecure };
