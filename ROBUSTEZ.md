# Robustez do Disparoy — o que mudou e por quê

Auditoria e correções de 13/08/2026. Este documento existe para o dia em que
alguém (você, daqui a seis meses) olhar uma dessas decisões e pensar "isso aqui
está complicado demais, dá para simplificar". A resposta está aqui.

## O princípio

O desenho anterior assumia que **o worker sempre termina o que começou**. Não
termina: o Render reinicia no deploy, o processo leva OOM, a VPS da Evolution
cai, a rede pisca. Nenhuma dessas coisas é excepcional — são terça-feira.

Toda correção abaixo é uma resposta à mesma pergunta: *e se o processo morrer
exatamente aqui?*

Três invariantes sustentam o sistema, e **todas moram no banco, não na fila**:

| Invariante | Coluna | Garante |
|---|---|---|
| Um contato vira job uma vez só | `campanha_contatos.enfileirado_em` | Sem envio duplicado |
| Jobs de execuções antigas morrem ao acordar | `campanhas.rodada` | Pausar/retomar sem duplicar |
| Retry retoma de onde parou | `mensagens_enviadas.passo` | Sem reenviar mensagem já entregue |

A fila (pg-boss) é transporte. Quando ela e o banco discordam, **o banco vence**.

---

## Os problemas corrigidos

### 1. Contato travava em `enviando` para sempre — campanha nunca concluía

O worker marcava `status = 'enviando'` e enviava. Se morresse no meio, o
contato ficava nesse status. `concluir_campanha_se_terminou` conta
`pendente/validando/enviando` como restantes, então a campanha ficava
`em_andamento` eternamente. **Nada de errado aparecia na tela — ela só não
andava mais.**

**Correção:** coluna `enviando_desde` + reaper (`reconciliar_disparos`) rodando
de minuto em minuto pelo cron do pg-boss. Contato parado há mais de 15 min
volta para `pendente` e é replanejado. Depois de 3 tentativas vira `falhou`,
para que uma linha problemática não segure a campanha para sempre.

### 2. O rate limit matava o webhook da Evolution

O comentário no `app.module.ts` afirmava que o webhook tinha teto próprio mais
alto. **Não tinha** — nenhum `@Throttle` no controller. Ele caía no limite
global de 40 requisições/10 s **por IP**, e todo evento da Evolution vem do
mesmo IP (a VPS). Uma mensagem gera 3–4 eventos.

O que se perdia num 429 não era cosmético: status de entrega sumindo do
relatório e, pior, **`MESSAGES_UPSERT` com pedido de saída sendo descartado** —
alguém pede para sair, a Evolution toma 429, o opt-out nunca é registrado, e a
próxima campanha alcança quem pediu para não ser alcançado.

**Correção:** `@Throttle` próprio (400/10 s, 2.000/min) no `EvolutionController`
e `@SkipThrottle()` no health check, que o Render bate de poucos em poucos
segundos.

### 3. Retry reenviava a sequência inteira

Job de contato tem `retryLimit: 2`. Sequência de 3 mensagens que falha na
terceira reenviava as duas primeiras. **A pessoa recebia a mesma mensagem duas
vezes** — que é o que faz o contato denunciar o número, exatamente o risco que
o sistema inteiro tenta evitar.

**Correção:** antes de enviar, o worker lê quais passos já saíram
(`passosJaEnviados`) e passa o conjunto para `dispararSequencia`, que os pula.
Coberto por teste.

### 4. `recalcular_metricas_campanha` rodava a cada evento de webhook

A função faz `count(*)` sobre todas as mensagens da campanha. Com 3–4 ACKs por
mensagem, uma campanha de 5.000 contatos disparava ~20 mil varreduras completas
e ~20 mil UPDATEs na **mesma linha** de `campanhas` — contenção de lock
garantida, tudo dentro do caminho de um webhook que precisa responder rápido. A
própria migration original dizia "chamado em lote, não por mensagem".

**Correção:** o webhook só grava o status da mensagem. Quem agrega é a
manutenção do worker, uma vez por minuto, para todas as campanhas ativas juntas
(`recalcular_metricas_campanhas_ativas`). O painel atrasa até 60 s; o banco
deixa de ser o gargalo. O recálculo imediato continua ao encerrar um contato,
que é quando o número muda de verdade.

### 5. Contagem de respostas perdia registros

`contarResposta` fazia SELECT seguido de UPDATE. Duas pessoas respondendo ao
mesmo tempo liam o mesmo valor e gravavam o mesmo incremento — uma resposta
simplesmente sumia. Em disparo, respostas simultâneas são o caso comum.

**Correção:** RPC `registrar_resposta` com incremento relativo à coluna
(`total_respostas + 1`), serializado pelo Postgres.

### 6. Planejamento enfileirava um a um, sem idempotência

5.000 contatos = 5.000 idas e voltas ao Postgres, e o job levava minutos —
janela para o worker reiniciar no meio e deixar parte da campanha sem job
nenhum. Pior: repetir o job (retry, dois cliques em "Disparar", retomada)
reenfileirava **todo** contato pendente. A única proteção era o `singletonKey`
do pg-boss, que **libera a chave assim que o job completa** — ou seja, não valia
nada depois do primeiro envio.

**Correção:** `reservarPendentes` faz `UPDATE ... WHERE enfileirado_em IS NULL
RETURNING id` — atômico, dois planejamentos concorrentes disputam a linha e só
um leva. O enfileiramento vira `boss.insert()` em lotes de 500. Se o insert
falhar, a reserva é devolvida (em fatias, para não estourar a URL do PostgREST).

### 7. Pausar não cancelava nada

`cancelarCampanha` chamava `boss.deleteJob(FILA_CAMPANHA, campanhaId)` passando
o id da **campanha** onde o pg-boss espera o id do **job**. Não apagava nada — e
ainda escrevia "jobs cancelados" no log. Os jobs de contato nunca eram tocados.

Pausar funcionava só porque `dispararContato` checa o status antes de enviar.
Mas isso criava um buraco: os jobs pausados acordavam, viravam no-op e
**completavam**, deixando `enfileirado_em` preenchido — ao retomar, esses
contatos nunca mais seriam alcançados.

**Correção:** `campanhas.rodada`. Cada job carrega a rodada em que nasceu;
pausar incrementa o contador (`invalidar_rodada_campanha`) e libera os pendentes
de uma vez só. Job de rodada vencida vira no-op ao acordar. Invalidação por
versão, não por remoção — não depende de a fila cooperar.

### 8. Cota queimada em envio que não aconteceu

A cota do canal era debitada pela sequência inteira antes de enviar. Falha na
primeira mensagem queimava a cota das outras. Em número novo, cota queimada à
toa é campanha parada mais cedo do que precisava.

**Correção:** reserva só os passos que faltam, e `devolver_cota_canal` devolve o
que não virou mensagem. A reserva antecipada continua — é ela que impede dois
workers de estourarem o teto do mesmo número.

---

## Segurança

| O que | Antes | Agora |
|---|---|---|
| `GET /` | `"talvez tenha alguma vulnerabilidade :)"` | `{ servico: "ok" }` |
| `/api/saude` | expunha quais provedores estão configurados | só `ok` e estado do banco; integração foi para `/api/eu`, que é autenticado |
| Cabeçalhos da API | nenhum | `nosniff`, `X-Frame-Options`, `Referrer-Policy`, CSP, HSTS em produção, `X-Powered-By` removido |
| Cabeçalhos do painel | nenhum | CSP, HSTS, `Permissions-Policy` e afins no `vercel.json` |
| `EVOLUTION_WEBHOOK_SECRET` | opcional — sem ele o webhook recusa TUDO em silêncio | obrigatório quando `NODE_ENV=production` |
| `APP_URL_PUBLICA`, `EVOLUTION_API_URL/KEY` | opcionais | obrigatórios em produção |
| `FILA_OPCIONAL=true` | aceito em produção (API sobe sem fila, campanhas nunca saem) | recusa o boot |
| IP real atrás do proxy | `req.ip` era o do Render → rate limit virava global e a auditoria gravava IP errado | `trust proxy` |
| `eventos_webhook` | crescia para sempre | retenção de 14 dias (só o que processou sem erro) |

Escrevi os cabeçalhos à mão em vez de usar `helmet`: esta API serve JSON e mais
nada, e dos quinze middlewares do helmet os quatro que importam aqui cabem em
vinte linhas. Uma dependência a menos para auditar e atualizar.

---

## Testes e CI

Não havia teste nenhum no backend nem CI em nenhum dos dois repositórios — e o
Render publica direto do `main`.

- `backend/src/auth/senha.test.ts` — scrypt: sal por linha, custo versionado,
  hash corrompido devolve `false` em vez de estourar, prefixo não passa.
- `backend/src/config/origens.test.ts` — o curinga do CORS cobre **um** rótulo
  do host. Garante que `https://disparoy-*.vercel.app` não case com
  `https://disparoy-x.vercel.app.invasor.com`, que seria leitura da API inteira
  com o token da vítima.
- `backend/src/whatsapp/sequencia.test.ts` — o checkpoint não reenvia passo já
  entregue, e a numeração continua casando com `mensagens_enviadas`.
- `backend/src/webhooks/status.test.ts` — status nunca regride quando o
  `DELIVERY_ACK` chega depois do `READ`.
- `.github/workflows/ci.yml` nos dois repos: `npm ci` → build → typecheck →
  testes, mais uma checagem de que nenhum `.env` foi versionado.

Teste não vai mais para `dist/`: o `nest build` agora usa `tsconfig.build.json`,
que os exclui. O `vitest` é devDependency e o Render instala só as dependências
de produção — um `dist/**/*.test.js` importando `vitest` é um require quebrado
esperando alguém carregá-lo.

---

## Para aplicar

```bash
# 1. Migration (Supabase SQL Editor ou supabase db push)
supabase/migrations/20260813000100_robustez.sql

# 2. Nada de novo no .env — mas em produção estes passam a ser obrigatórios:
#    EVOLUTION_API_URL, EVOLUTION_API_KEY, EVOLUTION_WEBHOOK_SECRET,
#    APP_URL_PUBLICA, e FILA_OPCIONAL precisa ser false.
#    Se algum faltar, a API recusa subir e diz qual — de propósito.

# 3. Deploy normal. A API e o worker precisam subir juntos: o cron de
#    manutenção é registrado pelo worker.
```

A migration é idempotente (`if not exists`, `create or replace`) e roda sobre o
banco que já está no ar.

## O que ficou de fora

- **Observabilidade.** Os logs vão para o stdout do Render, sem correlação por
  campanha e sem alerta. Quando uma campanha de 25 h falhar às 3h, ninguém fica
  sabendo. Próximo passo natural: Sentry ou Axiom no worker.
- **Verificação de conteúdo real da mídia.** O upload confere extensão e mime
  declarado, não os magic bytes. O bucket é público (o servidor do WhatsApp
  precisa baixar), então todo arquivo enviado vira URL pública permanente.
- **Backup do Supabase.** Confira o plano: no free não há PITR.
- **Multi-tenant.** O sistema é single-tenant por decisão. Virar SaaS exige
  `organizacao_id` em todas as tabelas e RLS por tenant — é mais fácil fazer
  agora, com o banco vazio, do que depois.
