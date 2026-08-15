# Caixa de avisos por perfil

Complemento de `ARQUITETURA-ATRIBUICAO-DE-FALHA.md`. Aquele documento faz o
sistema **saber** de quem foi a culpa. Este faz ele **avisar a pessoa certa**.

---

## 1. Por que não é só uma tela de log

A página `Logs` que já existe é auditoria: quem pausou, quem criou, quem entrou.
É passiva, histórica e imutável — você vai até ela quando já desconfia de algo.

A caixa de avisos é o contrário em todos os eixos:

| | Logs (auditoria) | Caixa (avisos) |
|---|---|---|
| Origem | ação humana | estado de máquina |
| Ciclo de vida | nunca muda | abre, é lido, resolve |
| Direção | você procura | ele te procura |
| Escopo | global | por perfil |
| Pergunta que responde | "o que aconteceu?" | "o que preciso fazer agora?" |

As duas ficam. Misturar seria perder a trilha de auditoria ou afogar o aviso
urgente no meio de duzentas linhas de `sessao.iniciada`.

---

## 2. A correção sobre o Realtime

Você escolheu Realtime do Supabase, e faz sentido à primeira vista — o Supabase
já está no stack. Mas a migration `20260809000200_login_proprio.sql` tirou o
Supabase Auth de circulação de propósito, e o cabeçalho dela explica por quê:

> *"o navegador precisando da anon key só para fazer login (...) Agora a API
> guarda `senha_hash` (scrypt) e assina o próprio JWT. O Supabase continua sendo
> o BANCO — só deixou de ser o autenticador."*

E `frontend/.env.example` confirma: *"O painel não guarda credencial nenhuma."*

Consequência concreta: as políticas em `20260808000200_rls.sql` usam `auth.uid()`,
que só existe quando o request chega com um JWT assinado pelo **segredo do
Supabase**. O token que o painel tem hoje é assinado com o seu `JWT_SECRET`. Se
você ligar `postgres_changes` no `notificacoes`, uma de duas coisas acontece:

- sem token Supabase, o RLS bloqueia tudo e ninguém recebe nada; ou
- você entrega a anon key ao navegador e a API passa a assinar um **segundo**
  token com o segredo do Supabase — exatamente o acoplamento que a migration
  removeu, agora de volta e em dobro.

**Recomendação: SSE pela própria API.** Mesma latência percebida, nenhuma
credencial nova no navegador, nenhuma política de RLS para manter em dia. E o
stack já prova que funciona: o `render.yaml` exige conexão de sessão na porta
5432 justamente porque o pg-boss depende de `LISTEN/NOTIFY`. A mesma conexão
serve aqui.

> Se ainda assim quiser Realtime: assine um segundo JWT com
> `SUPABASE_JWT_SECRET` contendo `sub = perfil.id` e `role = 'authenticated'`,
> exponha `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`, e crie a política
> `create policy caixa_propria on notificacoes for select using (perfil_id = auth.uid())`.
> Funciona. Só custa duas credenciais no navegador e uma segunda noção de
> identidade para manter sincronizada com a primeira.

Se o SSE incomodar, o plano B é de duas linhas: trocar por
`refetchInterval: 30_000` no React Query. Todo o resto deste documento continua
valendo sem mudar nada.

---

## 3. Duas tabelas, não uma

`incidentes` (do documento anterior) é **o fato**: uma linha por canal e código,
com `ocorrencias` incrementando. `notificacoes` é **a entrega**: uma linha por
pessoa que precisa saber.

Separar não é preciosismo. Se `lida_em` morasse no incidente, a Ana abrir o
aviso marcaria como lido para o Bruno também — e o Bruno é quem tem o celular na
mão. É o mesmo motivo pelo qual um e-mail para três pessoas gera três caixas.

E o `unique` em `(perfil_id, incidente_id, tipo)` é o que faz 4.812 contatos
falhando pelo mesmo motivo virarem **um** aviso, não 4.812.

---

## 4. Migration

`supabase/migrations/20260814000200_caixa_avisos.sql`

```sql
-- ============================================================================
-- Caixa de avisos por perfil.
--
-- `incidentes` guarda o fato; esta tabela guarda a entrega. Se o estado de
-- leitura morasse no incidente, uma pessoa lendo marcaria como lido para todas
-- — e num disparo quem precisa agir é justamente quem ainda não viu.
-- ============================================================================

create type tipo_notificacao as enum ('abertura', 'resolucao');

create table if not exists notificacoes (
  id            bigserial primary key,
  perfil_id     uuid not null references perfis (id) on delete cascade,

  -- Nulo em aviso que não vem de incidente (campanha concluída, importação
  -- terminada). A caixa não é só para erro.
  incidente_id  bigint references incidentes (id) on delete cascade,
  tipo          tipo_notificacao not null default 'abertura',

  -- Categoria é o que a tela usa para escolher o selo e a cor. Guardada como
  -- enum, não como texto: é ela que precisa agrupar e filtrar.
  categoria     categoria_falha not null,
  codigo        text not null,

  -- Texto JÁ renderizado, com nome de canal e contagens dentro. Guardado em vez
  -- de montado na leitura porque "4.812 contatos na fila" era verdade às 3h07 e
  -- não é mais amanhã. O aviso é um registro do momento, não uma consulta viva.
  titulo        text not null,
  corpo         text not null,

  canal_id      uuid references canais (id) on delete set null,
  campanha_id   uuid references campanhas (id) on delete set null,

  -- Botão do card. Nulo quando não há nada a fazer além de esperar.
  acao_rotulo   text,
  acao_rota     text,

  criada_em     timestamptz not null default now(),
  lida_em       timestamptz,
  arquivada_em  timestamptz
);

-- A consulta da caixa: as minhas, mais recentes primeiro.
create index if not exists notificacoes_caixa_idx
  on notificacoes (perfil_id, criada_em desc)
  where arquivada_em is null;

-- O número no sininho. Roda a cada abertura de página; precisa ser barato.
create index if not exists notificacoes_nao_lidas_idx
  on notificacoes (perfil_id)
  where lida_em is null and arquivada_em is null;

-- Um aviso por pessoa por incidente por tipo.
--
-- É esta linha que impede a enxurrada: quando um canal cai no meio de uma
-- campanha de 5.000, `abrir_incidente` é chamado por cada job que acorda. O
-- incidente já existe e só incrementa `ocorrencias` — mas sem este índice, uma
-- corrida entre dois workers ainda geraria avisos duplicados.
create unique index if not exists notificacoes_unicas_idx
  on notificacoes (perfil_id, incidente_id, tipo)
  where incidente_id is not null;

-- ---------------------------------------------------------------------------
-- Fan-out na ESCRITA, não na leitura.
--
-- Poderia ser uma view com join em `canal_membros` resolvida a cada consulta.
-- Não é: a caixa é lida muitas vezes por sessão e escrita poucas vezes por dia,
-- e um join de permissão no caminho de leitura vira o gargalo do painel.
-- Materializar na escrita também congela quem tinha acesso NAQUELE momento, que
-- é o comportamento certo — remover alguém de um canal não apaga o aviso que
-- ela já tinha recebido.
-- ---------------------------------------------------------------------------
create or replace function notificar_envolvidos() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into notificacoes (
    perfil_id, incidente_id, tipo, categoria, codigo,
    titulo, corpo, canal_id, campanha_id
  )
  select
    p.id, new.id, 'abertura', new.categoria, new.codigo,
    new.titulo, coalesce(new.detalhe, ''), new.canal_id, new.campanha_id
  from perfis p
  where p.ativo
    and (
      p.papel = 'admin'
      -- Incidente sem canal (configuração, infra geral) é assunto de admin.
      or (new.canal_id is not null and exists (
            select 1 from canal_membros m
            where m.canal_id = new.canal_id and m.perfil_id = p.id
          ))
    )
  on conflict do nothing;

  -- Acorda o SSE da API. Payload mínimo de propósito: o limite do pg_notify é
  -- 8 kB, e mandar o conteúdo aqui significaria duplicar a serialização.
  -- Quem tem o dado é a API, que já sabe consultar.
  perform pg_notify('avisos', new.id::text);
  return new;
end;
$$;

drop trigger if exists ao_abrir_incidente on incidentes;
create trigger ao_abrir_incidente
  after insert on incidentes
  for each row execute function notificar_envolvidos();

-- ---------------------------------------------------------------------------
-- Resolução também é aviso.
--
-- "Vendas 02 reconectou e a campanha retomou" é a mensagem que evita o telefone
-- tocando. Sem ela o operador fica olhando um aviso vermelho que já não vale.
-- ---------------------------------------------------------------------------
create or replace function notificar_resolucao() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.resolvido_em is not null or new.resolvido_em is null then
    return new;
  end if;

  insert into notificacoes (
    perfil_id, incidente_id, tipo, categoria, codigo,
    titulo, corpo, canal_id, campanha_id, lida_em
  )
  select
    n.perfil_id, new.id, 'resolucao', new.categoria, new.codigo,
    'Resolvido: ' || new.titulo,
    'Durou ' || to_char(new.resolvido_em - new.aberto_em, 'HH24h MImin') ||
      '. Nenhum contato foi perdido nem enviado duas vezes.',
    new.canal_id, new.campanha_id,
    -- A resolução nasce lida: ela informa, não pede ação. Deixá-la contar no
    -- sininho faria o número subir justamente quando o problema acabou.
    now()
  from notificacoes n
  where n.incidente_id = new.id and n.tipo = 'abertura'
  on conflict do nothing;

  -- Fecha o aviso de abertura junto: ele não tem mais o que pedir.
  update notificacoes
     set arquivada_em = now()
   where incidente_id = new.id and tipo = 'abertura' and arquivada_em is null;

  perform pg_notify('avisos', new.id::text);
  return new;
end;
$$;

drop trigger if exists ao_resolver_incidente on incidentes;
create trigger ao_resolver_incidente
  after update of resolvido_em on incidentes
  for each row execute function notificar_resolucao();

-- ---------------------------------------------------------------------------
-- Retenção. Aviso arquivado há mais de 90 dias não serve a ninguém — o que
-- precisa durar para sempre é `logs_auditoria`, e ele não é tocado aqui.
-- ---------------------------------------------------------------------------
create or replace function limpar_avisos_antigos(p_dias integer default 90)
returns integer
language sql security definer set search_path = public as $$
  with apagados as (
    delete from notificacoes
     where arquivada_em is not null
       and arquivada_em < now() - make_interval(days => p_dias)
    returning 1
  ) select count(*)::integer from apagados;
$$;

alter table notificacoes enable row level security;
```

> RLS fica ligado por consistência com as demais tabelas, mas sem política: a
> API usa service role e filtra por conta própria, como o cabeçalho do
> `rls.sql` já explica. Se um dia o Realtime entrar, a política vai aqui.

Adicione `limpar_avisos_antigos` ao `manutencao()` do worker, junto de
`limpar_eventos_webhook`.

---

## 5. A origem: o campo que responde à sua pergunta

O selo no topo de cada aviso é o produto inteiro. Ele não é armazenado — é
derivado de `categoria` em `shared/`, para que mudar uma palavra não exija
migração e para que não existam duas verdades sobre a mesma linha.

`shared/src/avisos.ts` (novo, nos dois repos):

```ts
import type { CategoriaFalha, CodigoFalha } from "./whatsapp/falhas";
import { FALHAS } from "./whatsapp/falhas";

export type Severidade = "critico" | "atencao" | "informativo";

export interface Origem {
  /** O selo. Escrito na língua do operador, não na do sistema. */
  rotulo: string;
  /** Tom visual: mapeia direto nas variáveis de cor do painel. */
  tom: "perigo" | "atencao" | "informacao" | "neutro";
  /** Primeira frase do corpo. Existe para dizer de quem NÃO é a culpa. */
  abertura: string;
}

export const ORIGENS: Record<CategoriaFalha, Origem> = {
  canal: {
    rotulo: "Seu WhatsApp",
    tom: "perigo",
    abertura: "O problema está no aparelho conectado, não no Disparoy.",
  },
  destinatario: {
    rotulo: "Números de destino",
    tom: "atencao",
    abertura: "Não é falha do sistema nem do seu número.",
  },
  infra: {
    rotulo: "Nosso servidor",
    tom: "informacao",
    abertura: "Não é problema do seu WhatsApp — ele continua conectado.",
  },
  configuracao: {
    rotulo: "Configuração",
    tom: "informacao",
    abertura: "Falta um ajuste na instalação; nada foi enviado errado.",
  },
  conteudo: {
    rotulo: "Sua mensagem",
    tom: "atencao",
    abertura: "O WhatsApp recusou o conteúdo desta campanha.",
  },
  limite: {
    rotulo: "Limite do canal",
    tom: "neutro",
    abertura: "Não é erro: é a proteção contra bloqueio funcionando.",
  },
};

export function origemDe(categoria: CategoriaFalha): Origem {
  return ORIGENS[categoria];
}

/**
 * Severidade a partir do perfil da falha.
 *
 * Derivada, não digitada: severidade é consequência de o disparo ter parado ou
 * não. Deixá-la solta abriria espaço para um aviso "informativo" que na verdade
 * parou 5.000 envios.
 */
export function severidadeDe(codigo: CodigoFalha): Severidade {
  const perfil = FALHAS[codigo];
  if (perfil.paraCampanha) return "critico";
  if (perfil.categoria === "destinatario" || perfil.categoria === "limite") {
    return "informativo";
  }
  return "atencao";
}
```

Repare no efeito de `abertura`: o aviso de infra **começa** dizendo que o
WhatsApp do cliente está bem. É a frase que decide se ele vai pegar o celular ou
te ligar — e é a que faltava no sistema inteiro.

---

## 6. Entrega por SSE

### 6.1 O stream carrega um cutucão, não o dado

O evento SSE não leva o conteúdo do aviso. Ele leva só `{ tipo: "avisos" }`, e
o front reage invalidando a chave do React Query, que refaz o `GET` normal.

Três motivos:

- o payload passa pela mesma rota autenticada de sempre, sem uma segunda
  serialização para manter em dia;
- se a conexão cair e voltar, o refetch já corrige tudo — não há estado
  perdido para reconciliar;
- trocar SSE por polling depois vira uma linha, porque a fonte do dado nunca
  foi o stream.

### 6.2 Autenticação: ticket de uso único

`EventSource` não aceita cabeçalho `Authorization` — é uma limitação da API do
navegador, não uma escolha. Passar o JWT na query string funcionaria, mas o
token completo iria parar nos logs de acesso do Render.

O caminho limpo:

```
POST /api/notificacoes/ticket   → { ticket: "<opaco>", expiraEm }   (autenticado)
GET  /api/notificacoes/stream?ticket=<opaco>                        (público, valida o ticket)
```

O ticket vive 60 s, é de uso único, e o que ele guarda em memória é só o
`perfil_id`. Vazar um ticket expirado não dá acesso a nada.

### 6.3 `backend/src/notificacoes/avisos.gateway.ts`

```ts
/**
 * Uma conexão LISTEN para o processo inteiro, não uma por cliente.
 *
 * `pg_notify` acorda TODOS os listeners: com duas instâncias de API no Render,
 * cada uma recebe e empurra para os clientes que estão nela. Nenhuma
 * coordenação entre instâncias é necessária — a propriedade cai de graça do
 * Postgres, e é por isso que isto não precisa de Redis.
 *
 * A conexão é dedicada e separada do pool: um cliente em LISTEN não pode ser
 * devolvido ao pool no meio, e o pg-boss já provou nesta stack que a conexão de
 * sessão da porta 5432 sustenta isso.
 */
@Injectable()
export class AvisosGateway implements OnModuleInit, OnModuleDestroy {
  private readonly inscritos = new Map<string, Set<Response>>();  // perfilId → respostas
  private cliente: Client | null = null;

  async onModuleInit(): Promise<void> {
    this.cliente = new Client({ connectionString: ambiente().DATABASE_URL });
    await this.cliente.connect();
    await this.cliente.query("listen avisos");

    this.cliente.on("notification", (msg) => {
      void this.empurrar(msg.payload);
    });

    // Sem isto, um LISTEN morto deixa de entregar em silêncio e a caixa
    // simplesmente para de atualizar sem nenhum erro visível.
    this.cliente.on("error", (e) => {
      this.logger.error(`LISTEN caiu: ${e.message}. Reconectando em 5 s.`);
      setTimeout(() => void this.reconectar(), 5_000);
    });
  }

  inscrever(perfilId: string, res: Response): void {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",  // no-transform: o proxy do Render não pode bufferizar
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    const doPerfil = this.inscritos.get(perfilId) ?? new Set();
    doPerfil.add(res);
    this.inscritos.set(perfilId, doPerfil);

    // Comentário SSE a cada 25 s. O Render derruba conexão ociosa, e uma
    // conexão morta que o navegador ainda considera viva é pior que nenhuma:
    // o EventSource não tenta reconectar.
    const batida = setInterval(() => res.write(": ping\n\n"), 25_000);

    res.on("close", () => {
      clearInterval(batida);
      doPerfil.delete(res);
      if (doPerfil.size === 0) this.inscritos.delete(perfilId);
    });
  }

  private async empurrar(incidenteId: string | undefined): Promise<void> {
    if (!incidenteId) return;

    // Quem precisa saber sai do banco, não do payload: o fan-out já resolveu a
    // permissão na escrita, e repetir a regra aqui seria uma segunda cópia dela.
    const { data } = await this.supabase.tabela("notificacoes")
      .select("perfil_id").eq("incidente_id", Number(incidenteId));

    for (const p of new Set((data ?? []).map((l) => l.perfil_id as string))) {
      for (const res of this.inscritos.get(p) ?? []) {
        res.write(`data: ${JSON.stringify({ tipo: "avisos" })}\n\n`);
      }
    }
  }
}
```

### 6.4 Endpoints

| Rota | O que faz |
|---|---|
| `GET /api/notificacoes?estado=abertos\|todos` | A caixa do próprio usuário, paginada |
| `GET /api/notificacoes/contagem` | Só o número do sininho |
| `POST /api/notificacoes/:id/lida` | Marca uma |
| `POST /api/notificacoes/lidas` | Marca todas |
| `POST /api/notificacoes/:id/arquivar` | Some da caixa, fica no banco |
| `POST /api/notificacoes/ticket` | Ticket de 60 s para o stream |
| `GET /api/notificacoes/stream?ticket=` | SSE |

**Regra inegociável:** todas filtram por `req.usuario.id`, nunca por um
`perfilId` vindo do cliente. A API usa a service role e ignora RLS — aqui não há
segunda linha de defesa, então o filtro é a defesa.

---

## 7. Painel

### Arquivos novos

```
frontend/src/components/avisos/
  sino-avisos.tsx      — sininho + contagem, mora no topo.tsx
  caixa-avisos.tsx     — o painel que abre
  cartao-aviso.tsx     — um aviso
  selo-origem.tsx      — o selo, lê ORIGENS de @disparoy/dominio
frontend/src/hooks/
  use-avisos.ts        — React Query + EventSource
frontend/src/paginas/
  avisos.tsx           — a caixa cheia, com filtro por origem
```

### `use-avisos.ts`

```ts
export function useAvisos() {
  const cliente = useQueryClient();

  useEffect(() => {
    let fonte: EventSource | null = null;
    let vivo = true;

    void (async () => {
      const { ticket } = await chamarApi<{ ticket: string }>("/notificacoes/ticket", {
        method: "POST",
      });
      if (!vivo) return;

      fonte = new EventSource(`${BASE}/notificacoes/stream?ticket=${ticket}`);

      // O evento não traz o aviso, só avisa que mudou. Quem busca é o React
      // Query, pela mesma rota autenticada de sempre — o stream nunca vira uma
      // segunda fonte de verdade que possa divergir da primeira.
      fonte.onmessage = () => {
        void cliente.invalidateQueries({ queryKey: ["avisos"] });
      };

      // O EventSource reconecta sozinho, mas com um ticket de uso único já
      // gasto — a reconexão dele bate num 401 eterno. Fechar e pedir ticket
      // novo é o que faz a reconexão de fato funcionar.
      fonte.onerror = () => {
        fonte?.close();
        if (vivo) setTimeout(() => void reconectar(), 3_000);
      };
    })();

    return () => { vivo = false; fonte?.close(); };
  }, [cliente]);

  return useQuery({ queryKey: ["avisos"], queryFn: () => chamarApi("/notificacoes") });
}
```

### `selo-origem.tsx`

Mapeia `origem.tom` nas variáveis de cor que o painel já usa — nunca uma cor
literal, para o modo escuro continuar funcionando:

| `tom` | fundo | texto |
|---|---|---|
| `perigo` | `--bg-danger` | `--text-danger` |
| `atencao` | `--bg-warning` | `--text-warning` |
| `informacao` | `--bg-accent` | `--text-accent` |
| `neutro` | `--surface-1` | `--text-secondary` |

### Onde aparece

1. **Sininho no `topo.tsx`** — contagem de não lidos, visível em toda tela.
2. **Faixa no `campanha-detalhe.tsx`** — quando a campanha está em
   `pausada_por_canal`, o aviso correspondente vira faixa no topo, com o mesmo
   selo. Redundante de propósito: quem está olhando a campanha não deveria
   precisar abrir outra tela para saber por que ela parou.
3. **Página `/avisos`** — a caixa cheia, com filtro por origem. É a tela que
   responde "isso é problema meu ou de vocês?" em um clique.

---

## 8. O que também vira aviso

A caixa não é só para erro — `incidente_id` é nulável justamente por isso. Vale
a pena mandar para lá:

- campanha concluída, com a taxa de entrega;
- importação de planilha terminada, com quantos contatos entraram e quantos
  foram recusados;
- canal chegando a 80% da cota diária (antes de travar, não depois);
- opt-out registrado por WhatsApp — hoje isso só existe como `logger.log` no
  `evolution.service.ts` e some no stdout do Render.

Esse último é o que mais dói perder: alguém pediu para sair, o sistema respeitou
corretamente, e ninguém no time ficou sabendo.

---

## 9. Ordem de aplicação

1. Migration `20260814000200_caixa_avisos.sql`. Depende da migration de
   incidentes do documento anterior — aplique aquela antes.
2. `shared/src/avisos.ts` nos dois repos.
3. Módulo `notificacoes/` no backend: service + controller + os cinco endpoints
   REST. **Pare aqui e teste.** Com polling de 30 s no front, a caixa já
   funciona inteira.
4. `AvisosGateway` + ticket + stream.
5. Componentes do painel e o sininho.
6. `limpar_avisos_antigos` no `manutencao()`.

Os passos 1 a 3 entregam o produto. O 4 só troca "em até 30 s" por "em 2 s".

---

## 10. Testes

| Arquivo | O que garante |
|---|---|
| `notificacoes/fanout.test.ts` | Admin recebe incidente de qualquer canal; operador só dos canais vinculados; operador sem vínculo não recebe nada. |
| `notificacoes/deduplicacao.test.ts` | Mil chamadas a `abrir_incidente` para o mesmo canal e código geram **um** aviso por pessoa. |
| `notificacoes/escopo.test.ts` | `GET /api/notificacoes` com o token do Bruno nunca devolve linha da Ana, mesmo passando `perfilId` no corpo ou na query. |
| `notificacoes/resolucao.test.ts` | Resolver o incidente arquiva a abertura e cria a resolução já lida, sem mexer no sininho. |
