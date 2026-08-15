# Disparoy — backend (API + worker)

Plataforma de disparo de WhatsApp. Este repositório tem a API REST, o worker de
disparo e as migrations. O painel vive em `Disparoy` (repositório separado).

## Antes de mudar qualquer coisa

Leia `docs/ARQUITETURA-ATRIBUICAO-DE-FALHA.md`. Ele explica por que o sistema
distingue "o WhatsApp do cliente caiu" de "nossa infraestrutura caiu", e quase
toda decisão estranha do worker sai daí.

`ROBUSTEZ.md` explica as três invariantes que impedem envio duplicado. Se algo
parecer complicado demais, a justificativa provavelmente está num desses dois.

## Idioma

Código, nomes e comentários em **português**. `campanhas`, `canais`, `disparo`,
`enfileirado_em`. Não traduza para inglês — o domínio inteiro é falado em
português com o cliente, e um vocabulário misto obriga a traduzir de cabeça toda
vez que se lê um bug report.

Exceção: bibliotecas externas mantêm o vocabulário delas (`fetch`, `Response`).

## Estrutura

```
shared/     @disparoy/dominio — regras puras, sem framework, sem rede
backend/    NestJS: API (main.ts) e worker (worker/main.worker.ts)
supabase/   migrations SQL, em ordem cronológica
```

**`shared/` é duplicado byte a byte no repositório do frontend.** Ao mexer nele,
copie para `../Disparoy/shared/src/` e confirme com `diff -rq`. Um `shared`
divergente entre os dois lados produz bug que só aparece em produção.

Nada em `shared/` pode importar Nest, React, `node:*` ou acessar rede. É o que
garante que normalizar um telefone se comporte igual nos três lugares.

## Dois processos, não um

A API aceita e agenda campanhas. Quem envia é o **worker**. Só a API no ar
significa campanha criada e nada saindo, sem erro visível em lugar nenhum.

Estado mora no Postgres, nunca em memória de processo. Uma campanha pode levar
horas e precisa sobreviver a deploy, restart e queda de rede.

## Regras que não se quebram

**Toda falha de envio tem `codigo: CodigoFalha`.** A união em
`shared/src/whatsapp/falhas.ts` é fechada e `ResultadoEnvio.codigo` é
obrigatório de propósito: o compilador recusa caminho de falha não classificado.
Nunca troque por `string`.

**Contato só vira `falhou` quando a culpa é do destinatário ou do conteúdo.**
Culpa do canal ou de infra devolve o contato para `pendente` e pausa a campanha
(`paraCampanha(codigo)`). Marcar `falhou` em massa destrói a campanha sem
possibilidade de reenvio.

**Nunca acuse o canal sem confirmar no gateway.** `canais.status` é cache do
webhook e mente quando o webhook morre. Quem decide é `estadoDaInstancia()`.
`indisponivel` (não consegui perguntar) nunca é tratado como `close` (perguntei
e caiu) — um é culpa nossa, o outro é do cliente.

**Nunca engula erro com `.catch(() => undefined)`** em caminho que o operador
precisa conhecer. Falha silenciosa foi a causa da maioria dos bugs já corrigidos
aqui. Se não dá para tratar, devolva um aviso.

**A API usa service role e ignora RLS.** Todo filtro de permissão é feito no
NestJS, à mão. As políticas em `supabase/migrations/*_rls.sql` são segunda
camada, não a primeira. Nunca aceite `perfilId` vindo do cliente — use
`req.usuario.id`.

**Nada de credencial no navegador.** O painel fala só com a API. Sem anon key,
sem `SUPABASE_SERVICE_ROLE_KEY`, sem chave da Evolution.

## Comentários

Comentário explica **por que**, nunca o quê. O padrão do repositório é registrar
a decisão e o que aconteceria sem ela — de preferência citando o defeito real
que a motivou. Comentário que parafraseia a linha seguinte é ruído.

## Migrations

Sempre idempotentes (`if not exists`, `create or replace`): rodam sobre banco
que já está no ar. Nomeadas `AAAAMMDDHHMMSS_assunto.sql`.

`alter type ... add value` vai em arquivo próprio — o valor novo não fica
visível para função `language sql` criada na mesma transação.

## Verificação

```bash
npm run typecheck    # nos dois repos
npm test             # vitest
```

Teste não vai para `dist/`: o `nest build` usa `tsconfig.build.json`, que os
exclui. O Render instala só dependências de produção, e um `dist/**/*.test.js`
importando vitest é require quebrado esperando alguém carregá-lo.

## Deploy

Render publica direto do `main`, API e worker juntos — o cron de manutenção é
registrado pelo worker. Frontend na Vercel.

Em produção, variáveis obrigatórias: `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`,
`EVOLUTION_WEBHOOK_SECRET`, `APP_URL_PUBLICA`, e `FILA_OPCIONAL=false`. Faltando
alguma, a API recusa subir e diz qual — de propósito.
