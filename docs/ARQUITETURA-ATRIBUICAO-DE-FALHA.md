# Disparoy — a estrutura certa para atribuir a falha

Auditoria de 14/08/2026 sobre `Disparoy` e `Disparoy-Backend`.

Objetivo único deste documento: fazer o sistema **provar** de quem foi a culpa
quando uma campanha para, em vez de adivinhar a partir de uma string de erro.

---

## 1. O que o Claude anterior fez bem, e onde ele parou

Vale dizer de saída: o `ROBUSTEZ.md` não é alucinação. Conferi cada um dos oito
itens contra o código e todos estão implementados de verdade — `enfileirado_em`,
`campanhas.rodada`, `passosJaEnviados`, o reaper `reconciliar_disparos`, o
`@Throttle` no webhook, a RPC `registrar_resposta`, o `boss.insert()` em lote, a
devolução de cota. As três invariantes que ele descreve existem e funcionam.

O que ele fez foi resolver **"o sistema não pode perder trabalho"**.

O que ele nunca fez foi **"o sistema precisa saber de quem foi a culpa"**. Ele
próprio admite no fim do documento: *"Observabilidade. Os logs vão para o stdout
do Render, sem correlação por campanha e sem alerta. Quando uma campanha de 25 h
falhar às 3h, ninguém fica sabendo."*

É exatamente aí que você está. E existe um agravante que ele não viu.

---

## 2. Os furos, com arquivo e linha

### Furo 1 — canal desconectado queima a campanha inteira

`backend/src/worker/disparo.service.ts:185`

```ts
if (canal.status !== "conectado") {
  await this.encerrarContato(job, "falhou", "Canal desconectado no momento do envio.");
  return;
}
```

Este é o furo mais caro do sistema.

O WhatsApp do cliente cai às 3h da manhã. Os 4.800 jobs restantes acordam um a
um, cada um passa por esta linha, cada um marca o contato como `falhou` e
**consome o job**. Em vinte minutos a campanha inteira está destruída:

- 4.800 linhas em `campanha_contatos` com status `falhou`;
- `concluir_campanha_se_terminou` não vê mais nenhum pendente e marca a campanha
  como `concluida`;
- o painel mostra "campanha concluída" com 4% de entrega;
- não há como reenviar sem `UPDATE` manual no Supabase.

E o motivo gravado é a string `"Canal desconectado no momento do envio."` em
`campanha_contatos.motivo` — texto livre, que ninguém agrupa, ninguém filtra e
que se perde no meio de outras vinte mensagens diferentes.

Pior: a checagem confia em `canais.status`, que é **um cache**, não um fato. Veja
o furo 3.

### Furo 2 — o código de erro é calculado e depois jogado fora

`shared/src/whatsapp/tipos.ts:42` define:

```ts
export type ResultadoEnvio =
  | { ok: true; idExterno: string }
  | { ok: false; erro: string; codigo?: string };
```

`backend/src/whatsapp/evolution-provider.ts:171` preenche esse `codigo`.

`backend/src/worker/disparo.service.ts:576-581` grava a mensagem:

```ts
id_externo: passo.resultado.ok ? (passo.resultado.idExterno ?? null) : null,
status:     passo.resultado.ok ? "enviada" : "falhou",
erro:       passo.resultado.ok ? null : (passo.resultado.erro ?? "Falha desconhecida"),
```

Não existe `codigo` nesse insert. E a tabela `mensagens_enviadas` também não tem
a coluna — só `erro text`.

Ou seja: o dado que responderia à sua pergunta é produzido a cada falha e
descartado uma função depois.

E mesmo se fosse gravado, não serviria: `ErroEvolution.codigo` recebe
`String(resposta.status)` — o **status HTTP**. Um `400` da Evolution pode ser
número inválido, `mediatype` errado, instância não pareada ou texto vazio.
Quatro causas totalmente diferentes, o mesmo código.

### Furo 3 — `canais.status` mente e nada o confere

O status do canal só muda quando chega um `CONNECTION_UPDATE`
(`backend/src/webhooks/evolution.service.ts`, `atualizarConexao`). Não existe
nenhuma consulta ativa a `instance/connectionState`. Consequência: se o webhook
não chegar, o banco fica com `conectado` para sempre enquanto o número está
offline no mundo real.

E há três formas concretas de o webhook não chegar:

1. **A VPS da Evolution caiu.** Sem processo, sem webhook. O banco continua
   dizendo `conectado`.
2. **O webhook nunca foi registrado.** `evolution-provider.ts:236-246`:

   ```ts
   if (env.APP_URL_PUBLICA && env.EVOLUTION_WEBHOOK_SECRET) {
     await chamar(CAMINHOS.definirWebhook(instancia), { ... }).catch(() => undefined);
   }
   ```

   Duas falhas silenciosas empilhadas. Se as variáveis faltam, o `if` inteiro é
   pulado sem aviso. Se a chamada falha, o `.catch(() => undefined)` engole. Nos
   dois casos o canal conecta, envia mensagens normalmente, e **nunca reporta
   status nenhum** — nem entrega, nem desconexão. O comentário logo acima dessa
   linha diz que isso não pode acontecer; o código permite que aconteça.
3. **O evento tomou 429.** O `@Throttle` novo cobre o caso normal, mas um pico
   ainda derruba eventos, e um `CONNECTION_UPDATE` perdido não é reenviado.

### Furo 4 — `banido` existe na tela mas nada nunca o define

`shared/src/tipos.ts:43` declara `StatusCanal = "conectado" | "desconectado" |
"aguardando_qr" | "banido"`, e `frontend/src/components/campanhas/selo-status.tsx:43`
tem o selo vermelho "Banido" pronto.

Um `grep -rn "banido"` no backend inteiro não retorna **nada**. Nenhum código
jamais grava esse status.

Isso significa que a pior falha possível — o número do cliente banido pela Meta,
que é irrecuperável e exige número novo — aparece no painel exatamente igual a
"o wi-fi do celular caiu por dois minutos".

### Furo 5 — erro de infra e erro de negócio compartilham o mesmo destino

Em `dispararSequencia` (`whatsapp.service.ts`), qualquer `resultado.ok === false`
quebra o laço e vira `houveFalha = true`, e o contato é encerrado como `falhou`
— permanente.

Um `500` da Evolution (VPS reiniciando, deveria ser retentado em 1 minuto) e um
`"number does not exist"` (definitivo, nunca vai funcionar) recebem tratamento
idêntico. O `retryLimit: 2` do pg-boss ajuda por acaso, mas ele não distingue os
dois: gasta as duas tentativas no número inexistente e pode não ter mais nenhuma
sobrando quando a Evolution voltar.

Além disso, `chamar()` em `evolution-provider.ts` só lança `ErroEvolution` para
respostas HTTP com erro. Se o `fetch` **rejeita** — DNS morto, `ECONNREFUSED`,
timeout de rede, que é justamente o sinal de "a VPS caiu" — a exceção não é
`ErroEvolution`, cai no `catch` genérico da linha 168 e vira a string
`"Falha ao falar com a Evolution API."` sem código nenhum. O sinal mais
importante de todos é o que menos informação carrega.

### Furo 6 — a fila de mortos não tem leitor

`fila.service.ts:14` cria `FILA_MORTOS` e a registra como `deadLetter` das duas
filas. O comentário diz: *"Aqui ele ao menos fica guardado, com o payload que
falhou."*

Nenhum `boss.work(FILA_MORTOS, ...)` existe. Nenhum endpoint lê a tabela. Nenhuma
tela mostra. Os jobs mortos ficam em `fila.job` no Supabase e nunca são vistos
por ninguém.

### Furo 7 — nenhuma correlação por campanha

`AuditoriaService` registra ação humana (quem pausou, quem criou). Não há tabela
de incidente de sistema. Quando a campanha para, não existe nada no banco que
diga *quando*, *por quê* e *ainda está acontecendo?*.

---

## 3. Por que tudo isso vira "erro do sistema" na sua cara

Junte os furos e o caminho fica óbvio:

1. A Evolution cai ou o celular do cliente perde a sessão.
2. O `canais.status` continua `conectado` no banco, porque o webhook morreu
   junto (furo 3).
3. Os envios começam a falhar com `500` ou `Connection Closed`.
4. O `fetch` rejeita, a causa real é apagada e vira `"Falha ao falar com a
   Evolution API."` (furo 5).
5. Isso é gravado em `mensagens_enviadas.erro` como texto livre, sem código
   (furo 2).
6. Os contatos viram `falhou` um por um, a campanha "conclui" com 4% (furo 1).
7. Nenhum incidente é aberto, nenhum alerta sai (furo 7).

O operador abre o painel, vê uma campanha concluída cheia de falhas com uma
mensagem genérica sobre a API, e conclui a única coisa que os dados permitem
concluir: **o sistema quebrou**.

O sistema não quebrou. Ele funcionou perfeitamente e não teve como dizer isso.

---

## 4. A estrutura certa: três camadas de responsabilidade

### Camada 1 — classificar na borda, nunca depois

Nenhuma string de erro sai de `evolution-provider.ts`. O que sai é um código de
uma união fechada. Se um caso novo aparecer, ele vira `desconhecido` e é
registrado como tal — mas nunca vira texto livre atravessando o sistema.

```ts
export type CategoriaFalha =
  | "canal"         // o WhatsApp do cliente
  | "destinatario"  // o número de destino
  | "infra"         // Evolution, rede, nosso host
  | "configuracao"  // credencial ou URL faltando
  | "conteudo"      // mídia ou texto rejeitado
  | "limite";       // cota atingida — não é erro
```

### Camada 2 — confirmar antes de acusar

Esta é a peça que hoje não existe em lugar nenhum, e é a que responde à sua
pergunta.

Quando um envio falha com um código da categoria `canal` ou `infra`, o worker
**não decide sozinho**. Ele faz uma chamada a
`GET instance/connectionState/{instancia}` e usa a resposta como veredito:

| Resposta do gateway | Veredito | Ação |
|---|---|---|
| `open`, suspeita de **canal** ou **conteúdo** | A sessão está viva: a suspeita sobre o canal caiu. Sobrou o destinatário ou o conteúdo. | Contato falha, campanha **continua**. |
| `open`, suspeita de **infra** ou **configuração** | A sessão está viva, mas isso não isenta o nosso lado. | `canais.status` **não muda**, incidente com o código original, contato volta a `pendente`, campanha vira `pausada_por_canal`. |
| `close` / `connecting` | O WhatsApp do cliente caiu de verdade. | `canais.status = 'desconectado'`, incidente `canal`, contato volta a `pendente`, campanha vira `pausada_por_canal`. |
| Não responde (timeout, `ECONNREFUSED`, 5xx) | A Evolution está fora do ar. Não é culpa do cliente. | `canais.status` **não muda**, incidente `infra`, contato volta a `pendente`, campanha vira `pausada_por_canal`. |

Custo: uma chamada HTTP, e só quando algo já falhou. Ganho: a diferença entre
"seu WhatsApp desconectou, escaneie o QR de novo" e "nosso servidor está fora do
ar, já estamos vendo" deixa de ser um chute.

Uma regra que sustenta isso: **contato só vira `falhou` quando a culpa é do
destinatário ou do conteúdo.** Culpa do canal ou da infra devolve o contato para
`pendente` e pausa a campanha. Nada se perde.

As duas primeiras linhas da tabela eram uma só, e a diferença entre elas custou
um bug. `open` era lido como "a suspeita era falsa", ponto — mas nem toda
suspeita que chega aqui é sobre o canal: `paraCampanha` também é verdadeiro para
`gateway_timeout`, `gateway_indisponivel` e `canal_mal_configurado`. Um envio
pode estourar timeout enquanto a consulta de estado, feita logo depois e mais
barata, responde `open` normalmente. O contato era encerrado como `falhou`
carregando `falha_categoria = 'infra'` — uma linha que se contradiz sozinha,
num status que nunca mais é reenviado, apesar de `retentavel: true` na
taxonomia. Quem separa os dois casos é `culpaNossa()`, em
`shared/src/whatsapp/falhas.ts`; `worker/atribuicao.test.ts` trava o
comportamento.

### Camada 3 — vigiar e reconciliar

O job de `manutencao()` que já roda de minuto em minuto ganha duas rotinas:

- **`vigiarCanais()`** — para todo canal `conectado` ou com campanha ativa,
  consulta o `connectionState` e reconcilia banco contra realidade. Fecha
  sozinho o incidente quando o canal volta, e retoma automaticamente as
  campanhas que estavam em `pausada_por_canal` por causa dele.
- **`drenarMortos()`** — consome `FILA_MORTOS` e abre um incidente para cada
  job morto, em vez de deixá-lo apodrecendo no schema `fila`.

---

## 5. Taxonomia fechada de falha

| Código | Categoria | Retry? | O que a tela diz |
|---|---|---|---|
| `canal_desconectado` | canal | não → pausa | "O WhatsApp de {canal} desconectou. Escaneie o QR Code novamente." |
| `canal_banido` | canal | não → pausa | "O número {numero} foi banido pelo WhatsApp. Será preciso um número novo." |
| `canal_sem_sessao` | canal | não → pausa | "A instância existe mas não está pareada. Conecte pelo QR Code." |
| `numero_inexistente` | destinatario | não | "Este número não tem WhatsApp." |
| `numero_recusou` | destinatario | não | "O contato bloqueou este número." |
| `gateway_indisponivel` | infra | sim | "Servidor da Evolution fora do ar. As campanhas retomam sozinhas." |
| `gateway_timeout` | infra | sim | idem |
| `gateway_sobrecarregado` | infra | sim (backoff) | "Servidor sobrecarregado, reduzindo o ritmo." |
| `credencial_invalida` | configuracao | não → pausa | "A chave da Evolution foi recusada. Verifique a configuração." |
| `evolution_nao_configurada` | configuracao | não → pausa | "Integração não configurada." |
| `midia_invalida` | conteudo | não | "A Evolution recusou o arquivo: {detalhe}." |
| `conteudo_recusado` | conteudo | não | "A mensagem foi recusada: {detalhe}." |
| `cota_diaria_atingida` | limite | adiado | "Limite diário de {canal} atingido. Continua amanhã." |
| `desconhecido` | infra | sim (1×) | "Falha não classificada: {detalhe}. Registrada para análise." |

### Regras de mapeamento da resposta da Evolution

Aplicadas em ordem, dentro de `evolution-provider.ts`:

```
fetch rejeita (TypeError, ECONNREFUSED, EAI_AGAIN, abort)  → gateway_indisponivel
HTTP 408 ou AbortError por timeout                          → gateway_timeout
HTTP 429                                                     → gateway_sobrecarregado
HTTP 401 / 403                                               → credencial_invalida
HTTP 404 em /message/send*                                   → canal_sem_sessao
HTTP 5xx                                                     → gateway_indisponivel
HTTP 4xx + mensagem casa /connection (closed|lost)|not connected|
           Connection Closed|no session/i                    → canal_desconectado
HTTP 4xx + mensagem casa /banned|forbidden device|
           account.*(blocked|banned)/i                       → canal_banido
HTTP 4xx + mensagem casa /not.*(exist|valid).*whatsapp|
           number.*not.*found|exists.*false/i                → numero_inexistente
HTTP 4xx + mensagem casa /mediatype|media|file|mimetype/i    → midia_invalida
HTTP 4xx demais                                              → conteudo_recusado
```

O detalhe original **continua sendo guardado** em `erro`. O código não substitui
o texto, ele o classifica. Quando um caso novo cair em `desconhecido`, o texto
bruto é o que permite criar a regra nova.

---

## 6. Migration

`supabase/migrations/20260814000100_atribuicao_falha.sql`

```sql
-- ============================================================================
-- Atribuição de falha: o sistema passa a dizer de quem foi a culpa.
--
-- Até aqui toda falha virava texto livre em `erro`/`motivo`. Texto livre não
-- agrupa, não filtra e não vira alerta — e por isso "o WhatsApp do cliente
-- desconectou" e "nosso worker quebrou" chegavam iguais na tela do operador.
-- ============================================================================

-- Novo estado: pausa causada pelo sistema, não pelo operador.
-- Precisa ser distinta de `pausada` porque só ela pode ser retomada
-- automaticamente. Retomar sozinho o que uma pessoa pausou de propósito seria
-- a pior surpresa possível num sistema de disparo.
alter type status_campanha add value if not exists 'pausada_por_canal';

create type categoria_falha as enum (
  'canal', 'destinatario', 'infra', 'configuracao', 'conteudo', 'limite'
);

-- O código já era calculado no provedor e descartado antes do insert.
alter table mensagens_enviadas
  add column if not exists erro_codigo    text,
  add column if not exists erro_categoria categoria_falha;

alter table campanha_contatos
  add column if not exists falha_codigo    text,
  add column if not exists falha_categoria categoria_falha;

-- Agrupamento por causa na tela de campanha.
create index if not exists mensagens_falha_idx
  on mensagens_enviadas (campanha_id, erro_categoria)
  where erro_categoria is not null;

-- `status` é cache do webhook. Estas colunas registram quando ele foi
-- conferido ativamente contra o gateway, e o que o gateway respondeu.
alter table canais
  add column if not exists estado_verificado_em timestamptz,
  add column if not exists estado_gateway       text,
  add column if not exists ultimo_erro_codigo   text;

-- Quem causou a pausa. Sem isto a retomada automática não sabe quais campanhas
-- soltar quando o canal voltar.
alter table campanhas
  add column if not exists pausada_por_canal_id uuid references canais (id) on delete set null,
  add column if not exists pausada_motivo       text;

-- ---------------------------------------------------------------------------
-- Incidentes: o que está quebrado agora, e desde quando.
--
-- Separado de `logs_auditoria` de propósito: auditoria é ação humana e é
-- imutável; incidente é estado de máquina, abre e fecha sozinho.
-- ---------------------------------------------------------------------------
create table if not exists incidentes (
  id           bigserial primary key,
  categoria    categoria_falha not null,
  codigo       text not null,
  canal_id     uuid references canais (id) on delete cascade,
  campanha_id  uuid references campanhas (id) on delete cascade,
  titulo       text not null,
  detalhe      text,
  ocorrencias  integer not null default 1,
  aberto_em    timestamptz not null default now(),
  visto_em     timestamptz not null default now(),
  resolvido_em timestamptz
);

-- Um incidente aberto por canal e código. Sem isto, 4.800 contatos falhando
-- pelo mesmo motivo abririam 4.800 incidentes e a tela viraria a mesma
-- enxurrada que ela existe para substituir.
create unique index if not exists incidentes_abertos_idx
  on incidentes (categoria, codigo, coalesce(canal_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where resolvido_em is null;

-- ---------------------------------------------------------------------------
-- Abre ou incrementa. Devolve o id.
-- ---------------------------------------------------------------------------
create or replace function abrir_incidente(
  p_categoria   categoria_falha,
  p_codigo      text,
  p_titulo      text,
  p_canal_id    uuid default null,
  p_campanha_id uuid default null,
  p_detalhe     text default null
) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  insert into incidentes (categoria, codigo, canal_id, campanha_id, titulo, detalhe)
  values (p_categoria, p_codigo, p_canal_id, p_campanha_id, p_titulo, p_detalhe)
  on conflict (categoria, codigo, coalesce(canal_id, '00000000-0000-0000-0000-000000000000'::uuid))
    where resolvido_em is null
  do update set
    ocorrencias = incidentes.ocorrencias + 1,
    visto_em    = now(),
    detalhe     = coalesce(excluded.detalhe, incidentes.detalhe)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function resolver_incidentes_do_canal(p_canal_id uuid)
returns integer
language sql security definer set search_path = public as $$
  with fechados as (
    update incidentes set resolvido_em = now()
    where canal_id = p_canal_id and resolvido_em is null
    returning 1
  ) select count(*)::integer from fechados;
$$;

-- ---------------------------------------------------------------------------
-- Pausa por causa de sistema. Devolve quantos contatos voltaram para a fila.
--
-- Um único UPDATE, não um laço: a campanha precisa parar antes do próximo job
-- acordar, e um laço de 5.000 linhas não para nada a tempo.
-- ---------------------------------------------------------------------------
create or replace function pausar_campanha_por_canal(
  p_campanha_id uuid,
  p_canal_id    uuid,
  p_motivo      text
) returns integer
language plpgsql security definer set search_path = public as $$
declare v_devolvidos integer;
begin
  update campanhas
     set status = 'pausada_por_canal',
         rodada = rodada + 1,               -- aposenta os jobs já enfileirados
         pausada_por_canal_id = p_canal_id,
         pausada_motivo = p_motivo
   where id = p_campanha_id
     and status in ('em_andamento', 'agendada');

  if not found then return 0; end if;

  -- Tudo que ainda não foi entregue volta a ser candidato. `enviando` entra
  -- junto: o job dele acabou de morrer com a sessão.
  update campanha_contatos
     set status = 'pendente',
         enfileirado_em = null,
         enviando_desde = null
   where campanha_id = p_campanha_id
     and status in ('pendente', 'validando', 'enviando');

  get diagnostics v_devolvidos = row_count;
  return v_devolvidos;
end;
$$;

-- ---------------------------------------------------------------------------
-- Retomada automática quando o canal volta.
--
-- Só solta o que ELE pausou. Campanha pausada por uma pessoa fica pausada.
-- ---------------------------------------------------------------------------
create or replace function retomar_campanhas_do_canal(p_canal_id uuid)
returns table (campanha_id uuid, rodada integer)
language sql security definer set search_path = public as $$
  update campanhas
     set status = 'em_andamento',
         pausada_por_canal_id = null,
         pausada_motivo = null
   where pausada_por_canal_id = p_canal_id
     and status = 'pausada_por_canal'
  returning id, rodada;
$$;
```

> `alter type ... add value` não roda dentro de bloco de transação em Postgres
> antigo. No Supabase 15+ funciona; se der erro, execute essa linha sozinha
> antes do resto.

---

## 7. Patches por arquivo

### 7.1 `shared/src/whatsapp/falhas.ts` (novo, nos DOIS repos)

O arquivo `shared/` é duplicado entre `Disparoy` e `Disparoy-Backend` — mantenha
os dois idênticos, como já está sendo feito hoje.

```ts
export type CategoriaFalha =
  | "canal" | "destinatario" | "infra" | "configuracao" | "conteudo" | "limite";

export type CodigoFalha =
  | "canal_desconectado" | "canal_banido" | "canal_sem_sessao"
  | "numero_inexistente" | "numero_recusou"
  | "gateway_indisponivel" | "gateway_timeout" | "gateway_sobrecarregado"
  | "credencial_invalida" | "evolution_nao_configurada"
  | "midia_invalida" | "conteudo_recusado"
  | "cota_diaria_atingida"
  | "desconhecido";

interface Perfil {
  categoria: CategoriaFalha;
  /** Vale a pena tentar de novo? */
  retentavel: boolean;
  /** Deve parar a campanha inteira, em vez de queimar só este contato? */
  paraCampanha: boolean;
  /** Texto para o operador. `{canal}` e `{detalhe}` são substituídos. */
  mensagem: string;
}

export const FALHAS: Record<CodigoFalha, Perfil> = {
  canal_desconectado: {
    categoria: "canal", retentavel: false, paraCampanha: true,
    mensagem: "O WhatsApp de {canal} desconectou. Escaneie o QR Code novamente para retomar.",
  },
  canal_banido: {
    categoria: "canal", retentavel: false, paraCampanha: true,
    mensagem: "O número de {canal} foi banido pelo WhatsApp. Será preciso usar outro número.",
  },
  canal_sem_sessao: {
    categoria: "canal", retentavel: false, paraCampanha: true,
    mensagem: "A instância de {canal} não está pareada. Conecte pelo QR Code.",
  },
  numero_inexistente: {
    categoria: "destinatario", retentavel: false, paraCampanha: false,
    mensagem: "Este número não tem WhatsApp.",
  },
  numero_recusou: {
    categoria: "destinatario", retentavel: false, paraCampanha: false,
    mensagem: "O contato bloqueou este número.",
  },
  gateway_indisponivel: {
    categoria: "infra", retentavel: true, paraCampanha: true,
    mensagem: "O servidor da Evolution está fora do ar. As campanhas retomam sozinhas quando ele voltar.",
  },
  gateway_timeout: {
    categoria: "infra", retentavel: true, paraCampanha: true,
    mensagem: "O servidor da Evolution não respondeu a tempo. Tentando novamente.",
  },
  gateway_sobrecarregado: {
    categoria: "infra", retentavel: true, paraCampanha: false,
    mensagem: "Servidor sobrecarregado. Reduzindo o ritmo do disparo.",
  },
  credencial_invalida: {
    categoria: "configuracao", retentavel: false, paraCampanha: true,
    mensagem: "A chave da Evolution foi recusada. Verifique EVOLUTION_API_KEY.",
  },
  evolution_nao_configurada: {
    categoria: "configuracao", retentavel: false, paraCampanha: true,
    mensagem: "A integração com a Evolution não está configurada.",
  },
  midia_invalida: {
    categoria: "conteudo", retentavel: false, paraCampanha: false,
    mensagem: "A Evolution recusou o arquivo: {detalhe}",
  },
  conteudo_recusado: {
    categoria: "conteudo", retentavel: false, paraCampanha: false,
    mensagem: "A mensagem foi recusada: {detalhe}",
  },
  cota_diaria_atingida: {
    categoria: "limite", retentavel: true, paraCampanha: false,
    mensagem: "O limite diário de {canal} foi atingido. O envio continua amanhã.",
  },
  desconhecido: {
    categoria: "infra", retentavel: true, paraCampanha: false,
    mensagem: "Falha não classificada: {detalhe}",
  },
};

export function explicar(
  codigo: CodigoFalha,
  ctx: { canal?: string; detalhe?: string } = {},
): string {
  return FALHAS[codigo].mensagem
    .replace("{canal}", ctx.canal ?? "o canal")
    .replace("{detalhe}", ctx.detalhe ?? "sem detalhe");
}

/**
 * Classifica a resposta da Evolution.
 *
 * `status = 0` significa que o fetch nem chegou a receber resposta — é o sinal
 * mais importante do sistema, porque distingue "a VPS caiu" de qualquer coisa
 * que o WhatsApp do cliente tenha feito. Hoje esse caso é o que menos
 * informação carrega; aqui ele é o primeiro a ser tratado.
 */
export function classificarEvolution(status: number, detalhe: string): CodigoFalha {
  const d = detalhe.toLowerCase();

  if (status === 0) {
    return /timeout|abort|etimedout/.test(d) ? "gateway_timeout" : "gateway_indisponivel";
  }
  if (status === 408) return "gateway_timeout";
  if (status === 429) return "gateway_sobrecarregado";
  if (status === 401 || status === 403) return "credencial_invalida";
  if (status === 404) return "canal_sem_sessao";
  if (status >= 500) return "gateway_indisponivel";

  if (/connection (closed|lost)|not connected|no session|closed by/.test(d))
    return "canal_desconectado";
  if (/banned|forbidden device|account.*(blocked|banned)/.test(d)) return "canal_banido";
  if (/not.*(exist|valid).*whatsapp|number.*not.*found|exists.*false|invalid.*jid/.test(d))
    return "numero_inexistente";
  if (/mediatype|media|mimetype|file/.test(d)) return "midia_invalida";

  return status >= 400 ? "conteudo_recusado" : "desconhecido";
}
```

E `ResultadoEnvio` em `shared/src/whatsapp/tipos.ts` passa a ser:

```ts
export type ResultadoEnvio =
  | { ok: true; idExterno: string }
  | { ok: false; erro: string; codigo: CodigoFalha };   // deixa de ser opcional
```

Tornar obrigatório é intencional: o compilador passa a recusar qualquer caminho
de falha que não classifique. É o que impede o furo 2 de voltar.

### 7.2 `backend/src/whatsapp/evolution-provider.ts`

Três mudanças.

**a) `chamar()` captura falha de rede em vez de deixar vazar.**

```ts
async function chamar<T>(caminho: string, init: RequestInit = {}): Promise<T> {
  const cfg = lerConfig();
  if (!cfg) throw new ErroEvolution(SEM_CONFIG, "evolution_nao_configurada");

  let resposta: Response;
  try {
    resposta = await fetch(`${cfg.baseUrl}/${caminho}`, {
      ...init,
      headers: { apikey: cfg.apiKey, "Content-Type": "application/json", ...init.headers },
      cache: "no-store",
      // Sem teto, um envio fica pendurado até o `expireInSeconds` de 23 h do
      // job. Nesse tempo a campanha inteira para sem ninguém saber por quê.
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    // Status 0: não houve resposta. É este ramo que distingue "a VPS caiu" de
    // "o WhatsApp do cliente caiu" — antes ele virava uma string genérica.
    const motivo = e instanceof Error ? e.message : String(e);
    throw new ErroEvolution(motivo, classificarEvolution(0, motivo));
  }

  const corpo = (await resposta.json().catch(() => ({}))) as RespostaEvolution;
  if (!resposta.ok) {
    const motivo = motivoDaFalha(corpo, resposta.status);
    throw new ErroEvolution(motivo, classificarEvolution(resposta.status, motivo));
  }
  return corpo as T;
}
```

`ErroEvolution.codigo` passa a ser tipado como `CodigoFalha`, não `string`.

**b) `enviar()` nunca perde o código.**

```ts
} catch (e) {
  if (e instanceof ErroEvolution) return { ok: false, erro: e.message, codigo: e.codigo };
  const motivo = e instanceof Error ? e.message : String(e);
  return { ok: false, erro: motivo, codigo: "desconhecido" };
}
```

**c) O registro do webhook deixa de falhar em silêncio.**

```ts
async function registrarWebhook(instancia: string): Promise<string | null> {
  const env = ambiente();
  if (!env.APP_URL_PUBLICA || !env.EVOLUTION_WEBHOOK_SECRET) {
    // Instância conectada sem webhook envia mensagens e nunca reporta nada:
    // nem entrega, nem desconexão. É o furo que faz o painel mentir.
    return "APP_URL_PUBLICA ou EVOLUTION_WEBHOOK_SECRET ausentes: este canal não vai reportar status.";
  }
  try {
    await chamar(CAMINHOS.definirWebhook(instancia), { /* ...igual ao atual... */ });
    return null;
  } catch (e) {
    return `Não foi possível registrar o webhook: ${e instanceof Error ? e.message : String(e)}`;
  }
}
```

O retorno vira o `aviso` que `CanaisService.criar` já sabe devolver ao painel.

**d) Novo: consultar o estado real.**

```ts
export type EstadoGateway = "open" | "close" | "connecting" | "indisponivel";

/**
 * Estado real da sessão, direto do gateway.
 *
 * É a única fonte confiável: `canais.status` no banco é cache do webhook, e o
 * webhook é justamente o que morre junto com a VPS.
 *
 * `indisponivel` NÃO é o mesmo que `close`. Um diz "não consegui perguntar"
 * (culpa nossa), o outro diz "perguntei e a sessão caiu" (WhatsApp do cliente).
 * Colapsar os dois é exatamente o erro que este arquivo existe para corrigir.
 */
export async function estadoDaInstancia(instancia: string): Promise<EstadoGateway> {
  if (!evolutionConfigurada()) return "indisponivel";
  try {
    const r = await chamar<{ instance?: { state?: string }; state?: string }>(
      CAMINHOS.estado(instancia),
    );
    const s = String(r.instance?.state ?? r.state ?? "").toLowerCase();
    if (s === "open") return "open";
    if (s === "connecting") return "connecting";
    if (s === "close") return "close";
    return "indisponivel";
  } catch (e) {
    // 404 é resposta: a instância não existe. Isso é fato sobre o canal.
    if (e instanceof ErroEvolution && e.codigo === "canal_sem_sessao") return "close";
    return "indisponivel";
  }
}
```

`CAMINHOS.estado` já existe no arquivo (linha 29) e nunca foi usado.

### 7.3 `backend/src/worker/disparo.service.ts`

**a) Substituir a linha 185.** Este é o patch mais importante do documento.

```ts
if (canal.status !== "conectado") {
  // NÃO marca o contato como falhou. `canais.status` é cache do webhook, e um
  // webhook perdido queimaria a campanha inteira por engano — 4.800 contatos
  // em vinte minutos, com a campanha fechando como "concluída" em seguida.
  // Quem decide é o gateway, não o banco.
  await this.tratarSuspeitaDeCanal(job, canal, "canal_desconectado", "cache do banco");
  return;
}
```

**b) O novo método que faz a pergunta.**

```ts
/**
 * Confirma no gateway antes de acusar alguém.
 *
 * O contato NUNCA vira `falhou` aqui: se a culpa é do canal ou da infra, ele
 * volta para `pendente` e a campanha pausa. Falha permanente é reservada a
 * causas permanentes — número que não existe, conteúdo recusado.
 */
private async tratarSuspeitaDeCanal(
  job: JobContato,
  canal: Canal,
  suspeita: CodigoFalha,
  detalhe: string,
): Promise<void> {
  const estado = await estadoDaInstancia(canal.instanciaEvolution);

  await this.supabase.tabela("canais").update({
    estado_verificado_em: new Date().toISOString(),
    estado_gateway: estado,
  }).eq("id", canal.id);

  // O gateway respondeu que está tudo bem: o cache mentia, e isso se corrige
  // independentemente de quem seja a culpa pela falha do envio.
  if (estado === "open") {
    await this.supabase.tabela("canais")
      .update({ status: "conectado" }).eq("id", canal.id);

    // Sessão viva derruba a suspeita sobre o CLIENTE, não sobre nós. Com
    // `gateway_timeout` ou `canal_mal_configurado`, `open` não prova nada, e o
    // contato cai no fluxo de baixo: volta para `pendente`, campanha pausa.
    if (!culpaNossa(suspeita)) {
      await this.encerrarContato(job, "falhou", explicar(suspeita, { detalhe }), suspeita);
      return;
    }
  }

  const codigo: CodigoFalha =
    estado === "indisponivel" ? "gateway_indisponivel" : suspeita;

  // Só rebaixa o canal quando o GATEWAY confirmou. Se ele não respondeu, o
  // problema é nosso — marcar o canal do cliente como desconectado nesse caso
  // seria acusar o inocente, que é o bug que estamos consertando.
  if (estado === "close" || estado === "connecting") {
    await this.supabase.tabela("canais")
      .update({ status: "desconectado", ultimo_erro_codigo: codigo })
      .eq("id", canal.id);
  }

  await this.supabase.db.rpc("abrir_incidente", {
    p_categoria: FALHAS[codigo].categoria,
    p_codigo: codigo,
    p_titulo: explicar(codigo, { canal: canal.nome }),
    p_canal_id: canal.id,
    p_campanha_id: job.campanhaId,
    p_detalhe: detalhe,
  });

  const { data: devolvidos } = await this.supabase.db.rpc("pausar_campanha_por_canal", {
    p_campanha_id: job.campanhaId,
    p_canal_id: canal.id,
    p_motivo: explicar(codigo, { canal: canal.nome }),
  });

  this.logger.warn(
    `Campanha ${job.campanhaId} pausada por ${codigo}: ${devolvidos ?? 0} contatos devolvidos à fila.`,
  );
}
```

**c) O laço de envio consulta o perfil da falha.**

Dentro de `aoTerminarPasso`, quando `!passo.resultado.ok`:

```ts
const perfil = FALHAS[passo.resultado.codigo];
if (perfil.paraCampanha) {
  await this.devolverCota(canal.id, restantes - enviados);
  await this.tratarSuspeitaDeCanal(job, canal, passo.resultado.codigo, passo.resultado.erro);
  return;                                   // não encerra o contato
}
houveFalha = true;
falhaCodigo = passo.resultado.codigo;
```

**d) `gravarMensagem` passa a persistir o código.**

```ts
await this.supabase.tabela("mensagens_enviadas").insert({
  // ...campos atuais...
  erro:           passo.resultado.ok ? null : passo.resultado.erro,
  erro_codigo:    passo.resultado.ok ? null : passo.resultado.codigo,
  erro_categoria: passo.resultado.ok ? null : FALHAS[passo.resultado.codigo].categoria,
});
```

**e) `encerrarContato` ganha o código.**

```ts
private async encerrarContato(
  job: JobContato,
  status: "concluido" | "falhou" | "invalido",
  motivo: string | null,
  codigo?: CodigoFalha,
): Promise<void> {
  await this.supabase.tabela("campanha_contatos").update({
    status, motivo,
    falha_codigo: codigo ?? null,
    falha_categoria: codigo ? FALHAS[codigo].categoria : null,
    processado_em: new Date().toISOString(),
    enviando_desde: null,
  }).eq("id", job.contatoId);
  // ...resto igual...
}
```

**f) A cota deixa de ser silenciosa.** No ramo `temCota !== true`, além do
`liberarParaReplanejar` atual, abrir incidente `cota_diaria_atingida`. Hoje isso
só existe como `logger.warn` e o operador nunca fica sabendo por que a campanha
desacelerou.

**g) `manutencao()` ganha duas rotinas.**

```ts
async manutencao(): Promise<void> {
  await this.vigiarCanais();          // novo — antes de tudo
  await this.reconciliarTravados();
  await this.replanejarPendentesOrfas();
  await this.agregarMetricas();
  await this.concluirOrfas();
  await this.limparEventosAntigos();
}

/**
 * Confere banco contra gateway, de minuto em minuto.
 *
 * Existe porque `canais.status` só muda por webhook, e o webhook é a primeira
 * coisa a morrer quando algo dá errado. Sem esta rotina, um canal pode ficar
 * `conectado` no banco por horas enquanto está offline de verdade — e todo
 * erro resultante parece erro do sistema.
 */
private async vigiarCanais(): Promise<void> {
  const { data } = await this.supabase.tabela("canais")
    .select("id, nome, status, instancia_evolution")
    .in("status", ["conectado", "desconectado"]);

  for (const canal of (data ?? []) as LinhaCanal[]) {
    const estado = await estadoDaInstancia(canal.instancia_evolution);
    // Gateway mudo não muda nada no banco: não sabemos, e chutar é o bug.
    if (estado === "indisponivel") continue;

    const real = estado === "open" ? "conectado" : "desconectado";
    if (real === canal.status) continue;

    await this.supabase.tabela("canais").update({
      status: real,
      estado_gateway: estado,
      estado_verificado_em: new Date().toISOString(),
    }).eq("id", canal.id);

    if (real === "conectado") {
      await this.supabase.db.rpc("resolver_incidentes_do_canal", { p_canal_id: canal.id });
      const { data: retomadas } = await this.supabase.db
        .rpc("retomar_campanhas_do_canal", { p_canal_id: canal.id });
      // A retomada precisa de um job de planejamento: os contatos voltaram a
      // `pendente`, mas quem enfileira é o planejamento, não o banco.
      for (const c of (retomadas ?? []) as { campanha_id: string; rodada: number }[]) {
        await this.fila.replanejar(c.campanha_id, c.rodada);
      }
      this.logger.log(`Canal ${canal.nome} voltou; ${(retomadas ?? []).length} campanha(s) retomadas.`);
    } else {
      await this.supabase.db.rpc("abrir_incidente", {
        p_categoria: "canal", p_codigo: "canal_desconectado",
        p_titulo: explicar("canal_desconectado", { canal: canal.nome }),
        p_canal_id: canal.id, p_campanha_id: null,
        p_detalhe: "detectado pela vigilância periódica",
      });
    }
  }
}
```

### 7.4 `backend/src/worker/main.worker.ts` — drenar a fila de mortos

```ts
// A dead letter só serve se alguém a lê. Hoje os jobs mortos ficam no schema
// `fila` e nunca são vistos — "evidência" que ninguém olha não é evidência.
await boss.work(FILA_MORTOS, { batchSize: 10 }, async (jobs) => {
  for (const j of jobs) await disparo.registrarJobMorto(j.data);
});
```

### 7.5 `backend/src/webhooks/evolution.service.ts`

Em `atualizarConexao`, quando o estado vira `close`, além do que já faz: abrir
incidente e chamar `pausar_campanha_por_canal` para toda campanha ativa que use
esse canal. Isso torna a reação **imediata** — o watchdog de 60 s vira a rede de
segurança, não o mecanismo principal.

E quando vira `open`: `resolver_incidentes_do_canal` +
`retomar_campanhas_do_canal` + `fila.replanejar`. O cliente reconecta o QR e a
campanha volta sozinha em segundos.

### 7.6 Frontend

**`paginas/campanha-detalhe.tsx`** — faixa no topo quando a campanha está em
`pausada_por_canal`, com a cor decidida pela **categoria**, nunca pela string:

- `canal` → faixa vermelha + botão "Reconectar WhatsApp" que leva direto ao QR
  daquele canal.
- `infra` / `configuracao` → faixa cinza-azulada: "não é problema do seu
  WhatsApp; nosso servidor está fora do ar e a campanha retoma sozinha."

A distinção precisa ser visível no primeiro segundo. É ela que decide se o
cliente vai pegar o celular ou te ligar.

**Tabela de contatos** — coluna "Motivo" deixa de mostrar texto cru e passa a
agrupar por `falha_categoria`, com contagem: `Sem WhatsApp (312) · Canal
desconectado (0) · Recusado (4)`.

**`paginas/dashboard.tsx`** — bloco de incidentes abertos no topo, lido de
`GET /api/incidentes?abertos=true`. Some sozinho quando tudo se resolve.

**`components/canais/lista-canais.tsx`** — mostrar `estado_verificado_em` como
"conferido há 40 s". Um canal `conectado` cuja última verificação foi há 3 dias
não é um canal conectado, é um canal sobre o qual não se sabe nada.

---

## 8. Ordem de aplicação

Cada passo é seguro sozinho e o sistema segue de pé entre eles.

1. **Migration.** Idempotente, roda sobre o banco no ar. Nada quebra: as colunas
   novas nascem nulas.
2. **`shared/falhas.ts` nos dois repos + `ResultadoEnvio.codigo` obrigatório.**
   O build vai apontar cada caminho de falha não classificado. Corrija todos —
   é essa lista que garante que nenhum some depois.
3. **`evolution-provider.ts`.** A partir daqui as falhas já chegam classificadas
   e a rede morta deixa de virar string genérica. Nada muda de comportamento
   ainda.
4. **`gravarMensagem` + `encerrarContato` gravando código e categoria.** Rode
   uma campanha real de teste e olhe `select erro_categoria, count(*) from
   mensagens_enviadas group by 1`. É a primeira vez que o sistema responde à sua
   pergunta.
5. **`tratarSuspeitaDeCanal` + a troca da linha 185.** Aqui o furo caro fecha.
6. **`vigiarCanais()` no `manutencao()`.**
7. **Reação imediata no webhook.**
8. **Frontend.**
9. **Drenar `FILA_MORTOS`.**

Faça 1–5 antes de qualquer campanha grande. Os passos 1 a 5 sozinhos já resolvem
"não dá para saber de quem foi a culpa"; 6 e 7 resolvem "a campanha não volta
sozinha".

---

## 9. Testes que precisam existir

Seguindo o padrão que já está em `backend/src/**/*.test.ts`:

| Arquivo | O que garante |
|---|---|
| `whatsapp/classificacao.test.ts` | Cada resposta conhecida da Evolution cai no código certo. Em especial: `status 0` vira `gateway_indisponivel` e **nunca** `canal_desconectado`. É a asserção central de todo o desenho. |
| `worker/atribuicao.test.ts` | Gateway responde `open` com suspeita de canal ou conteúdo → contato falha e campanha **continua**. Gateway responde `open` com suspeita de infra ou configuração → contato **não** falha, campanha pausa. Gateway responde `close` → contato volta a `pendente` e campanha pausa. Gateway mudo → canal **não** é rebaixado. |
| `worker/retomada.test.ts` | `retomar_campanhas_do_canal` solta o que foi pausado pelo sistema e **não** solta o que foi pausado por uma pessoa. |
| `worker/vigilancia.test.ts` | Canal `conectado` no banco com gateway em `close` é corrigido; gateway `indisponivel` não muda nada. |

---

## 10. O que continua de fora

- **Alerta ativo.** Os incidentes vivem no banco e aparecem no painel, mas
  ninguém é notificado às 3h. Passo natural: um job que manda o incidente novo
  para um grupo de WhatsApp por um canal interno, ou Sentry/Axiom no worker.
- **Multi-tenant.** Segue single-tenant, como o `ROBUSTEZ.md` já registrou. A
  tabela `incidentes` foi desenhada sem `organizacao_id` — se virar SaaS, ela
  entra na mesma leva das outras.
- **Health check da própria VPS da Evolution.** `vigiarCanais` detecta
  indiretamente, mas um ping direto a `GET /` da Evolution daria o sinal antes
  de qualquer envio falhar.
