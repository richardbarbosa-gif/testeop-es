# Radar de Opções

Painel pessoal de análise de mercado e gerador de operações com opções (B3 e EUA), com **camada anti-erro** que pode vetar qualquer recomendação.

> Ferramenta de apoio à decisão. Não é recomendação de investimento. Probabilidades vêm de modelo e não garantem resultado.

## O que faz

| Módulo | Conteúdo | Fonte (grátis) |
|---|---|---|
| Termômetro de risco | VIX, VXEWZ, DXY, USD/BRL, Treasury 10a, S&P futuro, Ásia, Europa, after-market do EWZ, Brent/cobre, noticiário → nota de -100 a +100 | Yahoo Finance, RSS |
| Brasil | Selic, CDI, IPCA 12m, PTAX, juro real, Focus (IPCA, câmbio, **caminho da Selic por reunião** — substituto da curva de DI) | Banco Central (SGS + Olinda) |
| Macro global | EUA, volatilidade (VIX, VVIX, MOVE, VXEWZ, VXEEM), juros EUA, dólar global, Ásia, Europa, commodities | Yahoo Finance |
| ADRs | Fechamento e after-market de EWZ, PBR, VALE, ITUB, BBD (prévia da abertura da B3) | Yahoo Finance |
| Fluxo | Anomalias de volume nos ativos; fluxo de opções (vol/OI, financeiro, agressão) com grade real | Yahoo / Tradier / OpLab |
| Gráfico | Candles, MME8, MME20, MMA200, suportes/resistências por pivôs, máx./mín. 52 semanas, IFR, ATR, vol. histórica, estrutura de topos/fundos | Yahoo Finance |
| Gerador de operação | Testa compra de call/put, travas de débito e crédito, venda coberta, diagonal, condor, straddle, calendário. Escolhe vencimento e strike por delta; calcula gregas, payoff, probabilidade de lucro, retorno/risco e tamanho da posição | Motor próprio (Black-Scholes) |
| Diário | Registra cada sugestão e mede a taxa de acerto real | Local (JSON) |

## Camada anti-erro (`src/quant/guards.js`)

Toda operação passa por 4 frentes antes de ser exibida. Qualquer **bloqueio** a descarta; **alertas** são exibidos.

1. **Integridade dos dados**: cobertura macro mínima, cotação velha com mercado aberto, preço incoerente com o histórico, VI disponível, filtro de plausibilidade (ex.: variação > 20% num índice = dado suspeito, excluído), referência de fechamento com mais de 6 dias, bid > ask, prêmio abaixo do intrínseco, VI fora de 3–250%, delta próprio x fornecedor.
2. **Coerência dos cálculos (auto-teste)**: perda máxima = débito, limites da trava ≤ largura, débito < largura, delta da posição no sentido do viés, pernas com preço válido.
3. **Risco de mercado**: venda descoberta de call sempre bloqueada; venda de put bloqueada em estresse; prazo mínimo (7 dias; 21 para compra a seco); spread de compra/venda; contratos em aberto; equilíbrio alcançável vs movimento esperado pela VI; qualidade do crédito; theta diário; eventos (FOMC, Copom, CPI, Payroll) antes do vencimento; dividendos x call vendida; movimento esticado (IFR extremo + > 2 ATR da MME20); gap esperado pelo after-market; conflito forte técnico x macro.
4. **Gestão de risco**: lotes dimensionados para não passar do risco máximo por operação (% do capital).

Além disso: nota mínima 58/100 e confiança direcional ≥ 35, senão a decisão é **NÃO OPERAR**. Sem grade real, a decisão vira **OPERAR — CONFIRMAR NO BOOK**.

Testes da matemática (Black-Scholes, paridade put-call, VI, gregas por diferenças finitas, guards): `npm test`.

## Modos de dados das opções

- **Teórico (padrão, sem token)**: grade sintética precificada por Black-Scholes. VI = VXEWZ real para o EWZ; para os demais, vol. histórica × prêmio de risco de vol. do Brasil (VXEWZ ÷ VH do EWZ), com skew. Série B3 indicada pela letra (calls A–L, puts M–X) + strike, **código a confirmar**.
- **Tradier** (`TRADIER_TOKEN`, conta de desenvolvedor gratuita): grade real de EWZ/PBR/VALE com volume e contratos em aberto → ativa o fluxo de opções EUA.
- **OpLab** (`OPLAB_TOKEN`, pago): grade real da B3. Conector escrito sem acesso à documentação oficial → **validar com dados reais ao configurar**.
- **Claude** (`ANTHROPIC_API_KEY`, opcional): reescreve a justificativa em linguagem de mesa, recebendo só os números calculados.

## Segurança

- Usuário único; senha guardada só como **hash scrypt** em variável de ambiente (nunca no código/GitHub).
- Sessão em cookie HttpOnly + Secure + SameSite=Strict assinado com HMAC; expira em 12 h.
- Bloqueio progressivo por IP (5 erros → 15 min; 10 → 1 h; 15 → 6 h) e atraso global sob ataque.
- 2FA TOTP opcional (Google Authenticator).
- CSP restritiva, HSTS, `noindex`, proteção CSRF (Origin + cabeçalho custom).
- Sem variáveis de segurança o servidor **não sobe** (falha fechada).

## Instalação local

```bash
npm install
npm run hash            # pede a senha e imprime APP_PASS_HASH e SESSION_SECRET
cp .env.example .env    # preencha APP_USER, APP_PASS_HASH (entre aspas simples), SESSION_SECRET
npm start
```

## Hospedagem (Hostinger, plano Business – Node.js)

1. Criar o site/subdomínio Node.js e apontar para este repositório (deploy por Git).
2. Configurar as variáveis de ambiente no painel (Node.js → Variáveis de ambiente): `NODE_ENV=production`, `APP_USER`, `APP_PASS_HASH`, `SESSION_SECRET`, `DATA_DIR` (pasta fora do app, ex. `/home/<usuario>/opcoes-data`) e, se quiser, `TOTP_SECRET`, `RISK_CAPITAL`, `RISK_MAX_PCT`, tokens.
3. Comando de inicialização: `npm start` (arquivo de entrada `server.js`).

Calendário de eventos e feriados editável em `config/events.json`.
