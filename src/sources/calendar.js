'use strict';
// Calendário: vencimentos de opções (B3 e EUA), Payroll e eventos do arquivo config/events.json.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'config', 'events.json');

function loadCfg() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return { events: [], holidaysB3: [] };
  }
}

const iso = (d) => d.toISOString().slice(0, 10);
const utc = (y, m, d) => new Date(Date.UTC(y, m, d));

function nthWeekday(y, m, weekday, n) {
  const first = utc(y, m, 1);
  const delta = (weekday - first.getUTCDay() + 7) % 7;
  return utc(y, m, 1 + delta + 7 * (n - 1));
}

function prevBusinessDay(d, holidays) {
  const x = new Date(d);
  while (x.getUTCDay() === 0 || x.getUTCDay() === 6 || holidays.has(iso(x))) x.setUTCDate(x.getUTCDate() - 1);
  return x;
}

// Vencimento mensal de opções sobre ações na B3: terceira sexta-feira do mês
// (dia útil anterior se feriado).
function b3Expirations(count = 8, from = new Date()) {
  const hol = new Set(loadCfg().holidaysB3 || []);
  const out = [];
  let y = from.getUTCFullYear(), m = from.getUTCMonth();
  while (out.length < count) {
    const d = prevBusinessDay(nthWeekday(y, m, 5, 3), hol);
    if (d >= utc(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())) out.push(iso(d));
    m++;
    if (m > 11) { m = 0; y++; }
  }
  return out;
}

function usExpirations(count = 8, from = new Date()) {
  const out = [];
  let y = from.getUTCFullYear(), m = from.getUTCMonth();
  while (out.length < count) {
    const d = nthWeekday(y, m, 5, 3);
    if (d >= utc(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())) out.push(iso(d));
    m++;
    if (m > 11) { m = 0; y++; }
  }
  return out;
}

// Letras de série B3: calls A–L, puts M–X (jan..dez).
function b3SeriesLetter(type, isoDate) {
  const m = Number(isoDate.slice(5, 7)) - 1;
  return String.fromCharCode((type === 'call' ? 65 : 77) + m);
}

function upcoming(days = 45) {
  const now = new Date();
  const until = new Date(now.getTime() + days * 86400e3);
  const today = iso(now);
  const cfg = loadCfg();
  const ev = [];
  for (const e of cfg.events || []) if (e.date >= today && e.date <= iso(until)) ev.push({ ...e, source: 'config' });
  for (const d of b3Expirations(3)) if (d <= iso(until)) ev.push({ date: d, title: 'Vencimento de opções B3', type: 'vencimento', impact: 2 });
  for (const d of usExpirations(3)) if (d <= iso(until)) ev.push({ date: d, title: 'Vencimento mensal de opções EUA', type: 'vencimento', impact: 1 });
  // Payroll: 1ª sexta-feira do mês (data provável — o BLS pode deslocar).
  for (let k = 0; k < 3; k++) {
    const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k, 1));
    const d = iso(nthWeekday(base.getUTCFullYear(), base.getUTCMonth(), 5, 1));
    const dd = d.endsWith('-01-01') ? iso(new Date(Date.parse(d) + 7 * 86400e3)) : d; // BLS desloca no feriado de Ano-Novo
    if (dd >= today && dd <= iso(until)) ev.push({ date: dd, title: 'Payroll EUA (emprego)', type: 'emprego-eua', impact: 3, confirmar: true });
  }
  ev.sort((a, b) => a.date.localeCompare(b.date));
  return ev.map((e) => ({ ...e, daysAway: Math.round((Date.parse(e.date) - Date.parse(today)) / 86400e3) }));
}

// Eventos de alto impacto entre hoje e a data de vencimento informada.
function eventsUntil(isoExpiry) {
  const today = iso(new Date());
  return upcoming(400).filter((e) => e.date >= today && e.date <= isoExpiry && e.impact >= 3);
}

module.exports = { upcoming, eventsUntil, b3Expirations, usExpirations, b3SeriesLetter };

function isB3Holiday(d = new Date()) {
  const brt = new Date(d.getTime() - 3 * 3600e3);
  return new Set(loadCfg().holidaysB3 || []).has(iso(brt));
}
module.exports.isB3Holiday = isB3Holiday;
