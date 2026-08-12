import { z } from "zod";

/**
 * Variáveis de ambiente validadas no boot.
 *
 * Falhar aqui é de propósito: é muito melhor a API não subir do que descobrir
 * uma credencial faltando no meio de um disparo de 20 mil contatos.
 */
/** Modelo de uso geral da Groq, quando o .env não escolhe outro. */
const MODELO_GROQ_PADRAO = "llama-3.3-70b-versatile";

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
   * Configurável porque o catálogo da Groq muda rápido: modelo desativado vira
   * um valor no .env, não um deploy.
   *
   * `GROQ_MODELO=` vazio cai no padrão em vez de recusar o boot — é um estado
   * comum demais no .env para derrubar a API inteira por causa de um recurso
   * opcional.
   */
  GROQ_MODELO: z
    .string()
    .trim()
    .default(MODELO_GROQ_PADRAO)
    .transform((v) => v || MODELO_GROQ_PADRAO),

  // --- Meta Cloud API (opcional) ------------------------------------------
  META_WHATSAPP_TOKEN: z.string().optional(),
  META_WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().optional(),
  META_GRAPH_API_VERSION: z.string().default("v21.0"),

  /** Envios simultâneos por canal. Subir demais é convite a bloqueio. */
  DISPARO_CONCORRENCIA_POR_CANAL: z.coerce.number().int().min(1).max(20).default(1),
})
  // Meio par de credenciais não cria admin nenhum e falha calado no boot;
  // é melhor a API recusar subir e dizer o que falta.
  .refine((v) => Boolean(v.ADMIN_EMAIL) === Boolean(v.ADMIN_SENHA), {
    path: ["ADMIN_SENHA"],
    message: "ADMIN_EMAIL e ADMIN_SENHA precisam ser preenchidos juntos.",
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

export function origensPermitidas(): string[] {
  return ambiente()
    .ORIGENS_PERMITIDAS.split(",")
    .map((o) => o.trim())
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
  padroesCache ??= origensPermitidas().map(paraRegex);
  return padroesCache.some((p) => p.test(origem));
}
