import { z } from "zod";

/**
 * Variáveis de ambiente validadas no boot.
 *
 * Falhar aqui é de propósito: é muito melhor a API não subir do que descobrir
 * uma credencial faltando no meio de um disparo de 20 mil contatos.
 */

/** Origem do Vite em desenvolvimento, quando o .env não lista outras. */
const ORIGENS_PADRAO = "http://localhost:5173";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(3333),
  /**
   * Origens liberadas no CORS, separadas por vírgula.
   *
   * Vazia cai no padrão em vez de virar lista vazia: `.default()` só vale para
   * a chave AUSENTE, e a chave existir vazia é o estado natural aqui — é o que
   * o `.env.example` traz e o que `sync: false` cria no painel do Render. Sem
   * este transform, `ORIGENS_PERMITIDAS=` bloqueia o front inteiro no CORS,
   * com a API subindo saudável e o erro aparecendo só no console do navegador.
   */
  ORIGENS_PERMITIDAS: z
    .string()
    .trim()
    .default(ORIGENS_PADRAO)
    .transform((v) => v || ORIGENS_PADRAO),

  // --- Supabase -----------------------------------------------------------
  SUPABASE_URL: z.string().url(),
  /**
   * Ignora RLS. Só a API e o worker podem tê-la — nunca o navegador.
   *
   * É a única chave do Supabase que o sistema usa: a anon key existia para o
   * frontend autenticar, e o login agora é próprio.
   */
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),

  // --- Sessão -------------------------------------------------------------
  /**
   * Segredo HS256 com que ESTA API assina os tokens de login.
   *
   * Nada a ver com o Supabase: a autenticação é própria. Trocar este valor
   * invalida todas as sessões abertas — é o botão de "derrubar todo mundo".
   * Gere com: openssl rand -hex 32
   */
  JWT_SECRET: z.string().min(32, "Use pelo menos 32 caracteres (openssl rand -hex 32)."),
  /** Validade do token. Sem refresh token: expirou, faz login de novo. */
  SESSAO_HORAS: z.coerce.number().int().min(1).max(720).default(12),

  /**
   * Conexão DIRETA do Postgres (porta 5432), não o pooler em modo transaction:
   * o pg-boss usa LISTEN/NOTIFY e advisory locks, que o pooler não repassa.
   */
  DATABASE_URL: z.string().url(),

  /**
   * Deixa a API subir mesmo sem conseguir conectar a fila.
   *
   * Só para desenvolvimento, e nunca em produção: campanhas continuam sendo
   * criadas, mas nenhuma sai — as rotas de disparo respondem 503 e o log
   * carrega o motivo em nível de erro. O worker ignora esta variável.
   */
  FILA_OPCIONAL: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // --- Administrador inicial ----------------------------------------------
  /**
   * Sem auto-cadastro, alguém precisa nascer admin — senão a instalação sobe
   * sem ninguém capaz de criar os demais acessos. A API garante esse usuário
   * no boot, uma vez só: se a conta já existe, a senha do .env é ignorada.
   */
  ADMIN_EMAIL: z.string().email().optional().or(z.literal("")),
  ADMIN_SENHA: z.string().min(6).optional().or(z.literal("")),
  ADMIN_NOME: z.string().trim().min(2).max(120).default("Administrador"),

  // --- Evolution API ------------------------------------------------------
  EVOLUTION_API_URL: z.string().url().optional().or(z.literal("")),
  EVOLUTION_API_KEY: z.string().optional(),
  /**
   * Segredo compartilhado validado em POST /webhooks/evolution.
   *
   * O endpoint é público por natureza (a Evolution precisa alcançá-lo pela
   * internet), então sem isso qualquer um poderia forjar status de entrega ou
   * disparar opt-out de contatos alheios.
   */
  EVOLUTION_WEBHOOK_SECRET: z.string().min(16).optional(),
  /** URL pública desta API, registrada na Evolution ao criar a instância. */
  APP_URL_PUBLICA: z.string().url().optional().or(z.literal("")),

  // --- Geração de variações (opcional) ------------------------------------
  /**
   * Chave da Groq, usada só para gerar variações de texto a partir do
   * original. Sem ela o botão "Gerar variações" responde 503 com o motivo —
   * o resto do sistema não depende disto, e escrever as opções à mão continua
   * funcionando igual.
   */
  GROQ_API_KEY: z.string().optional(),
  /**
   * PINO do modelo. Vazio — que é o padrão — significa "escolha sozinho".
   *
   * Antes isto tinha um padrão fixo no código, e o padrão apodreceu: a Groq
   * desligou `llama-3.3-70b-versatile` em 16/08/2026 e o botão "Gerar
   * variações" passou a responder 422 até alguém editar o `.env`. O catálogo
   * dela muda rápido demais para um nome escrito à mão em qualquer lugar.
   *
   * Quem escolhe agora é `resolverModelo` (`spintax/gerador.ts`), perguntando à
   * própria Groq o que existe na conta. Preencher esta variável desliga essa
   * escolha e força o valor — serve para prender uma versão específica quando o
   * texto gerado importa mais que o modelo estar atual.
   *
   * Continua sem recusar o boot quando vem lixo: geração de variações é
   * recurso opcional, e derrubar a API inteira por causa dela seria trocar um
   * botão quebrado por um sistema fora do ar.
   */
  GROQ_MODELO: z.string().trim().default(""),

  // --- Meta Cloud API (opcional) ------------------------------------------
  META_WHATSAPP_TOKEN: z.string().optional(),
  META_WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().optional(),
  META_GRAPH_API_VERSION: z.string().default("v21.0"),

  /**
   * Quantos jobs de contato o worker tira da fila por rodada.
   *
   * O NOME MENTE, e mudá-lo agora quebraria o `render.yaml` e todo `.env` que
   * já existe — então fica o aviso: isto NÃO é "por canal". O valor vira o
   * `batchSize` da fila `disparo-contato` em `main.worker.ts`, que é GLOBAL:
   * vale para todos os canais, todas as campanhas e todas as empresas
   * somados. Com o padrão `1`, o worker processa um contato por vez no sistema
   * inteiro.
   *
   * Não há nada que distribua a concorrência entre canais ou entre clientes —
   * a fila é uma só e o pg-boss entrega por ordem de `startAfter`. O que
   * impede um cliente de monopolizar a fila é o teto de contatos por
   * planejamento e a cota diária por empresa (`comum/limites-empresa.ts`), não
   * este número.
   *
   * SUBIR ISTO SEM ESTUDAR NÃO ACELERA E PODE CUSTAR CARO: o handler percorre
   * o lote com `await` sequencial, então o paralelismo real continua sendo 1 —
   * só sai mais job da fila por rodada. Trocar o laço por `Promise.all` para
   * ganhar vazão de verdade faria vários contatos saírem no MESMO instante,
   * anulando o `startAfter` sorteado de cada job — e cadência simultânea é um
   * dos dois padrões que mais pesam no risco de bloqueio do número (o outro é
   * cadência fixa, que os intervalos aleatórios já tratam).
   */
  DISPARO_CONCORRENCIA_POR_CANAL: z.coerce.number().int().min(1).max(20).default(1),

  /**
   * Quanto tempo depois da hora marcada uma campanha agendada ainda pode
   * começar. Passado isso ela vira `falhou` e NADA é enviado.
   *
   * Existe porque o contrário já aconteceu: o worker esteve fora na hora do
   * agendamento, voltou depois, e a fila entregou o job com o `startAfter`
   * vencido — a campanha inteira saiu horas atrasada. Mensagem de WhatsApp
   * chega no celular de uma pessoa com hora na tela; "promoção só hoje"
   * entregue de madrugada no dia seguinte é pior do que não entregue.
   *
   * O piso de 5 minutos NÃO é conservadorismo: a manutenção roda de minuto em
   * minuto e `reivindicar_agendamentos_vencidos` espera 5 min de carência
   * antes de tentar reenfileirar de novo. Com tolerância menor que a carência,
   * a segunda tentativa nunca acontece — um reinício do Render no minuto errado
   * mataria uma campanha que teria saído sozinha no minuto seguinte.
   *
   * Quem quiser rigor de "na hora ou não vai" põe 5. O padrão de 30 é o que
   * atravessa um deploy ruim sem matar campanha nenhuma.
   */
  AGENDAMENTO_TOLERANCIA_MINUTOS: z.coerce.number().int().min(5).max(1440).default(30),

  // --- Observabilidade externa (opcional) ---------------------------------
  /**
   * URL que recebe um POST com JSON a cada erro não classificado (500 da API,
   * exceção não tratada no worker).
   *
   * NÃO é a integração com uma ferramenta específica — não há SDK de Sentry
   * nem de nenhum APM aqui dentro, só um `fetch` com corpo genérico. Serve
   * para apontar direto a um webhook de entrada do Slack/Discord/Teams (todos
   * aceitam POST de JSON simples) ou a qualquer endpoint próprio que
   * repasse para onde quiser depois — inclusive um projeto Sentry, através de
   * algo que traduza o webhook para a API deles.
   *
   * Sem isto configurado, os erros continuam só no log do Render — o que
   * funciona enquanto alguém está olhando, e não avisa ninguém quando não
   * está.
   *
   * O sistema NÃO finge ter alertado quando isto falta: o vigia do worker
   * grava `alerta_estado = 'desabilitado'` no incidente e o boot da API
   * registra a ausência em nível de erro. Ver `VigiaWorkerService` e
   * `ObservabilidadeService.enviarAlerta`.
   *
   * O VALOR É SEGREDO. Numa URL de webhook do Slack/Discord o token está no
   * caminho: quem tem a URL posta no canal. Por isso ela nunca é escrita em
   * log — `ObservabilidadeService` troca o endereço por um marcador antes de
   * registrar qualquer falha de envio.
   */
  ALERTA_WEBHOOK_URL: z.string().url().optional().or(z.literal("")),
})
  // Meio par de credenciais não cria admin nenhum e falha calado no boot;
  // é melhor a API recusar subir e dizer o que falta.
  .refine((v) => Boolean(v.ADMIN_EMAIL) === Boolean(v.ADMIN_SENHA), {
    path: ["ADMIN_SENHA"],
    message: "ADMIN_EMAIL e ADMIN_SENHA precisam ser preenchidos juntos.",
  })
  /**
   * Em produção, o que é opcional em desenvolvimento vira obrigatório.
   *
   * Todos estes deixavam a API subir saudável e falhar em silêncio depois:
   *
   *  - sem `EVOLUTION_WEBHOOK_SECRET`, o endpoint de webhook recusa TUDO. Os
   *    disparos saem normalmente e nenhum status volta: a campanha fica cheia
   *    de "enviada" que nunca vira "entregue", e o opt-out de quem pediu para
   *    sair nunca chega. Ninguém liga uma coisa na outra até alguém reclamar
   *    de receber mensagem depois de ter pedido para parar.
   *  - sem `APP_URL_PUBLICA`, a instância nem é registrada na Evolution — o
   *    webhook nunca é chamado, mesmo com o segredo certo.
   *  - sem `EVOLUTION_API_URL`/`KEY`, todo envio falha um a um, com a campanha
   *    andando e cada contato marcado como falha.
   *
   * `FILA_OPCIONAL` entra na lista pelo motivo oposto: ele existe para deixar
   * a API subir SEM fila, e uma API sem fila em produção aceita campanhas e
   * não envia nenhuma.
   */
  .superRefine((v, ctx) => {
    if (v.NODE_ENV !== "production") return;

    const exigir = (campo: keyof typeof v, porque: string) => {
      if (!v[campo]) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [campo], message: porque });
      }
    };

    exigir("EVOLUTION_API_URL", "Obrigatório em produção: sem gateway, nenhum envio sai.");
    exigir("EVOLUTION_API_KEY", "Obrigatório em produção: sem gateway, nenhum envio sai.");
    exigir(
      "EVOLUTION_WEBHOOK_SECRET",
      "Obrigatório em produção: sem ele o webhook recusa tudo, e nenhum status " +
        "de entrega nem pedido de saída (opt-out) é registrado.",
    );
    exigir(
      "APP_URL_PUBLICA",
      "Obrigatório em produção: é o endereço que a Evolution usa para entregar " +
        "os webhooks. Sem ele a instância sobe sem webhook nenhum.",
    );

    /**
     * Existir não basta: precisa ser alcançável DE FORA.
     *
     * `z.string().url()` aceita `http://localhost:3333` sem reclamar, e foi
     * exatamente esse valor que ficou meses em produção. A API subia sem erro,
     * o painel funcionava, as campanhas saíam — e a Evolution passava o dia
     * tentando entregar evento no localhost da VPS DELA. Nenhuma entrega,
     * nenhuma leitura e nenhuma resposta jamais chegou, e nada em lugar nenhum
     * dizia por quê.
     *
     * É a pior classe de defeito que este sistema pode ter: silencioso,
     * permanente, e indistinguível de "o WhatsApp do cliente não respondeu".
     * O único momento em que dá para pegá-lo de graça é aqui, no boot — depois
     * disso ninguém liga uma coisa na outra até alguém reclamar.
     *
     * Recusar o boot é proporcional: uma API no ar sem webhook é pior do que
     * uma API que não sobe, porque a primeira parece que está funcionando.
     */
    const publica = v.APP_URL_PUBLICA?.trim();
    if (publica) {
      const alvo = (() => {
        try {
          return new URL(publica).hostname.toLowerCase();
        } catch {
          return null;
        }
      })();

      // Loopback, link-local e as três faixas privadas da RFC 1918: tudo que
      // só resolve de dentro da própria máquina ou da própria rede.
      const inalcancavel =
        alvo !== null &&
        (alvo === "localhost" ||
          alvo === "0.0.0.0" ||
          alvo.endsWith(".local") ||
          /^127\./.test(alvo) ||
          /^10\./.test(alvo) ||
          /^192\.168\./.test(alvo) ||
          /^169\.254\./.test(alvo) ||
          /^172\.(1[6-9]|2\d|3[01])\./.test(alvo));

      if (inalcancavel) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["APP_URL_PUBLICA"],
          message:
            `"${publica}" não é alcançável pela internet, e é a Evolution — que roda ` +
            "em outra máquina — que precisa chegar até aqui. Com um endereço destes a " +
            "API sobe normalmente e NENHUMA entrega, leitura ou resposta é registrada, " +
            "sem erro em lugar nenhum. Use a URL pública desta API.",
        });
      }
    }

    if (v.FILA_OPCIONAL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["FILA_OPCIONAL"],
        message:
          "Precisa ser false em produção: com true a API sobe sem fila e as " +
          "campanhas são criadas sem nunca serem enviadas.",
      });
    }
  });

export type Ambiente = z.infer<typeof schema>;

let cache: Ambiente | null = null;

export function ambiente(): Ambiente {
  if (cache) return cache;

  const resultado = schema.safeParse(process.env);
  if (!resultado.success) {
    const faltando = resultado.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Configuração de ambiente inválida:\n${faltando}\n\n` +
        `Copie backend/.env.example para backend/.env e preencha os valores.`,
    );
  }

  cache = resultado.data;
  return cache;
}

let segredoCache: Uint8Array | null = null;

/** Segredo de assinatura já codificado, do jeito que o `jose` espera. */
export function segredoJwt(): Uint8Array {
  segredoCache ??= new TextEncoder().encode(ambiente().JWT_SECRET);
  return segredoCache;
}

function normalizarOrigem(origem: string): string {
  return origem
    .trim()
    .replace(/\/+$/, "")
    .replace(/^(https?:\/\/[^/]+)(?:\/.*)?$/, "$1");
}

export function origensPermitidas(): string[] {
  return ambiente()
    .ORIGENS_PERMITIDAS.split(",")
    .map((o) => normalizarOrigem(o))
    .filter(Boolean);
}

/**
 * Compila uma entrada de ORIGENS_PERMITIDAS em regex ancorada.
 *
 * O `*` existe por causa da Vercel: cada deploy gera um domínio novo
 * (`disparoy-frontend-<hash>-<time>.vercel.app`), então uma lista de origens
 * exatas envelhece a cada publicação. `https://disparoy-frontend-*.vercel.app`
 * cobre todos eles.
 *
 * O curinga é `[^./]*` de propósito, e não `.*`: sem isso
 * `https://*.vercel.app` casaria com `https://vercel.app.invasor.com` e com
 * subdomínios de terceiros — o curinga vale para UM rótulo do host, só.
 */
function paraRegex(padrao: string): RegExp {
  const partes = padrao.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${partes.join("[^./]*")}$`);
}

let padroesCache: RegExp[] | null = null;

/** Se a origem do navegador está liberada, considerando os curingas. */
export function origemPermitida(origem: string): boolean {
  const origemNormalizada = normalizarOrigem(origem);
  padroesCache ??= origensPermitidas().map(paraRegex);
  return padroesCache.some((p) => p.test(origemNormalizada));
}
