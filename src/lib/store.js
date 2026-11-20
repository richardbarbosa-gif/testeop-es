'use strict';
// Persistência simples em JSON (gravação atômica). DATA_DIR deve ficar FORA da pasta pública
// e fora da pasta substituída a cada deploy (na Hostinger: ex. /home/<usuario>/opcoes-data).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('../config');

function file(name) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  return path.join(config.dataDir, name);
}

function read(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return fallback;
  }
}

function write(name, data) {
  const f = file(name);
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, f);
}

const journal = {
  list: () => read('journal.json', []),
  add(entry) {
    const all = journal.list();
    const e = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), status: 'aberta', ...entry };
    all.unshift(e);
    write('journal.json', all.slice(0, 1000));
    return e;
  },
  update(id, patch) {
    const all = journal.list();
    const i = all.findIndex((x) => x.id === id);
    if (i < 0) return null;
    all[i] = { ...all[i], ...patch };
    write('journal.json', all);
    return all[i];
  },
  remove(id) {
    const all = journal.list();
    const next = all.filter((x) => x.id !== id);
    write('journal.json', next);
    return next.length !== all.length;
  },
};

// Histórico diário de VI ATM (só com grade real) para calcular IV Rank/Percentil próprios.
const ivHistory = {
  record(ticker, iv) {
    if (!Number.isFinite(iv)) return;
    const all = read('ivhist.json', {});
    const day = new Date().toISOString().slice(0, 10);
    const arr = all[ticker] || [];
    if (arr.length && arr[arr.length - 1].d === day) arr[arr.length - 1].iv = iv;
    else arr.push({ d: day, iv });
    all[ticker] = arr.slice(-400);
    write('ivhist.json', all);
  },
  stats(ticker, current) {
    const arr = (read('ivhist.json', {})[ticker] || []).slice(-252).map((x) => x.iv);
    if (arr.length < 30 || !Number.isFinite(current)) return { days: arr.length, rank: null, percentile: null };
    const lo = Math.min(...arr), hi = Math.max(...arr);
    return { days: arr.length, rank: hi > lo ? ((current - lo) / (hi - lo)) * 100 : null, percentile: (arr.filter((x) => x <= current).length / arr.length) * 100 };
  },
};

module.exports = { journal, ivHistory };
