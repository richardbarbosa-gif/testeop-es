'use strict';
// Black-Scholes-Merton com dividend yield contínuo (q).
// Convenções: T em anos (dias corridos/365), sigma e r em fração (0.30 = 30%).
// theta = variação por DIA corrido; vega = por 1 ponto de vol; rho = por 1 ponto de juros.

function normPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

// CDF normal com precisão ~1e-15 (algoritmo de Hart/West).
function normCdf(x) {
  const z = Math.abs(x);
  let c;
  if (z > 37) c = 0;
  else {
    const e = Math.exp(-z * z / 2);
    if (z < 7.07106781186547) {
      let n = 0.0352624965998911 * z + 0.700383064443688;
      n = n * z + 6.37396220353165;
      n = n * z + 33.912866078383;
      n = n * z + 112.079291497871;
      n = n * z + 221.213596169931;
      n = n * z + 220.206867912376;
      let d = 0.0883883476483184 * z + 1.75566716318264;
      d = d * z + 16.064177579207;
      d = d * z + 86.7807322029461;
      d = d * z + 296.564248779674;
      d = d * z + 637.333633378831;
      d = d * z + 793.826512519948;
      d = d * z + 440.413735824752;
      c = (e * n) / d;
    } else {
      let b = z + 0.65;
      b = z + 4 / b;
      b = z + 3 / b;
      b = z + 2 / b;
      b = z + 1 / b;
      c = e / b / 2.506628274631;
    }
  }
  return x > 0 ? 1 - c : c;
}

function d1d2(S, K, T, r, q, sigma) {
  const sT = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / sT;
  return [d1, d1 - sT];
}

function price(type, S, K, T, r, sigma, q = 0) {
  if (T <= 0 || sigma <= 0) return Math.max(0, type === 'call' ? S - K : K - S);
  const [d1, d2] = d1d2(S, K, T, r, q, sigma);
  const dfq = Math.exp(-q * T), dfr = Math.exp(-r * T);
  return type === 'call' ? S * dfq * normCdf(d1) - K * dfr * normCdf(d2) : K * dfr * normCdf(-d2) - S * dfq * normCdf(-d1);
}

function greeks(type, S, K, T, r, sigma, q = 0) {
  if (T <= 0 || sigma <= 0) {
    const itm = type === 'call' ? S > K : S < K;
    return { price: price(type, S, K, 0, r, sigma, q), delta: itm ? (type === 'call' ? 1 : -1) : 0, gamma: 0, theta: 0, vega: 0, rho: 0, probITM: itm ? 1 : 0 };
  }
  const [d1, d2] = d1d2(S, K, T, r, q, sigma);
  const dfq = Math.exp(-q * T), dfr = Math.exp(-r * T), sq = Math.sqrt(T);
  const pdf = normPdf(d1);
  const p = price(type, S, K, T, r, sigma, q);
  const gamma = (dfq * pdf) / (S * sigma * sq);
  const vega = (S * dfq * pdf * sq) / 100;
  let delta, theta, rho, probITM;
  if (type === 'call') {
    delta = dfq * normCdf(d1);
    theta = (-(S * dfq * pdf * sigma) / (2 * sq) - r * K * dfr * normCdf(d2) + q * S * dfq * normCdf(d1)) / 365;
    rho = (K * T * dfr * normCdf(d2)) / 100;
    probITM = normCdf(d2);
  } else {
    delta = -dfq * normCdf(-d1);
    theta = (-(S * dfq * pdf * sigma) / (2 * sq) + r * K * dfr * normCdf(-d2) - q * S * dfq * normCdf(-d1)) / 365;
    rho = (-K * T * dfr * normCdf(-d2)) / 100;
    probITM = normCdf(-d2);
  }
  return { price: p, delta, gamma, theta, vega, rho, probITM };
}

// Volatilidade implícita por bisseção robusta (monótona em sigma). Retorna null se o preço
// viola limites de arbitragem — sinal de dado ruim (usado pela camada anti-erro).
function impliedVol(type, mkt, S, K, T, r, q = 0) {
  if (!(mkt > 0) || T <= 0) return null;
  const intrinsic = Math.max(0, type === 'call' ? S * Math.exp(-q * T) - K * Math.exp(-r * T) : K * Math.exp(-r * T) - S * Math.exp(-q * T));
  const upper = type === 'call' ? S * Math.exp(-q * T) : K * Math.exp(-r * T);
  if (mkt < intrinsic - 1e-9 || mkt >= upper) return null;
  let lo = 1e-4, hi = 5;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (price(type, S, K, T, r, mid, q) > mkt) hi = mid;
    else lo = mid;
    if (hi - lo < 1e-6) break;
  }
  return (lo + hi) / 2;
}

// Distribuição lognormal de S_T para probabilidades de estruturas multi-perna.
// drift: retorno anual esperado (risco-neutro = r - q). Retorna pontos {s, w} com pesos que somam 1.
function lognormalGrid(S, T, sigma, drift, n = 400) {
  const mu = Math.log(S) + (drift - 0.5 * sigma * sigma) * T;
  const sd = sigma * Math.sqrt(T);
  const pts = [];
  const zMax = 5;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const z = -zMax + (2 * zMax * (i + 0.5)) / n;
    const w = normPdf(z);
    pts.push({ s: Math.exp(mu + sd * z), w });
    sum += w;
  }
  for (const p of pts) p.w /= sum;
  return pts;
}

module.exports = { price, greeks, impliedVol, normCdf, normPdf, lognormalGrid };
