'use strict';
// Gera as variáveis de segurança. A senha é lida do terminal (não fica no histórico do shell).
//   node scripts/hash-password.js            -> pede a senha
//   echo -n 'senha' | node scripts/hash-password.js --stdin
//   adicione --totp para gerar também um segredo de 2FA (Google Authenticator)
const crypto = require('crypto');
const readline = require('readline');
const { hashPassword } = require('../src/lib/auth');

function base32(buf) {
  const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) out += a[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

async function readPassword() {
  if (process.argv.includes('--stdin')) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => { if (!s.includes('\n')) rl.output.write('*'); else rl.output.write(s); };
  return new Promise((r) => rl.question('Senha: ', (a) => { rl.close(); process.stdout.write('\n'); r(a); }));
}

(async () => {
  const pass = await readPassword();
  if (!pass || pass.length < 10) { console.error('Senha muito curta (mínimo 10).'); process.exit(1); }
  console.log(`APP_PASS_HASH=${hashPassword(pass)}`);
  console.log(`SESSION_SECRET=${crypto.randomBytes(48).toString('base64url')}`);
  if (process.argv.includes('--totp')) {
    const secret = base32(crypto.randomBytes(20));
    console.log(`TOTP_SECRET=${secret}`);
    console.error(`\nCadastre no Google Authenticator: otpauth://totp/RadarOpcoes?secret=${secret}&issuer=RadarOpcoes`);
  }
})();
