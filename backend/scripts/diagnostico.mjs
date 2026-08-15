/**
 * Testa, uma a uma, as credenciais de que a API e o worker dependem.
 *
 * Existe porque as falhas de credencial aqui não aparecem no boot: a Evolution
 * só é chamada no primeiro envio, a Groq só no botão de variações, e o
 * DATABASE_URL em modo errado sobe a API e engasga na fila. O sintoma chega
 * horas depois, como "campanha não saiu", e a causa some no meio do log.
 *
 * Cada teste diz o que tentou, o que recebeu e o que fazer — nunca só "falhou".
 *
 * Uso:
 *
 *   node backend/scripts/diagnostico.mjs
 *   node backend/scripts/diagnostico.mjs --enviar +5511999999999
 *
 * Lê backend/.env sozinho. Variáveis já presentes no ambiente têm precedência,
 * que é o que permite rodar isto no Shell do Render sem .env nenhum.
 *
 * Sem `--enviar` não escreve nada: não cria instância, não manda mensagem, não
 * altera tabela. Só leitura, de propósito — é para poder rodar com a produção
 * no ar.
 *
 * `--enviar` manda UMA mensagem de teste pelo mesmo endpoint que o worker usa,
 * e exige o número na linha de comando justamente para nunca acontecer por
 * engano. É o único jeito de provar o caminho inteiro antes de confiar nele
 * numa campanha de verdade.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const aqui = dirname(fileURLToPath(import.meta.url));

/** Nenhum teste pode segurar o diagnóstico esperando um host que não responde. */
const TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// .env
// ---------------------------------------------------------------------------

/**
 * Parser próprio em vez de `dotenv`: este script precisa rodar também no
 * Render, onde só as dependências de PRODUÇÃO são instaladas — e o dotenv
 * entra por baixo do @nestjs/config, que é dependência transitiva e pode sumir
 * numa atualização. Um `require` a menos é um jeito a menos de o diagnóstico
 * morrer antes de diagnosticar qualquer coisa.
 *
 * O `\r` no fim é retirado à mão: o .env editado no Windows vem com CRLF, e sem
 * isto toda chave terminaria com um caractere invisível — a Evolution
 * responderia 401 com a chave certa e ninguém veria o motivo olhando o arquivo.
 */
function carregarEnv(caminho) {
  let bruto;
  try {
    bruto = readFileSync(caminho, "utf8");
  } catch {
    return 0;
  }

  let lidas = 0;
  for (const linha of bruto.split("\n")) {
    const limpa = linha.replace(/\r$/, "").trim();
    if (!limpa || limpa.startsWith("#")) continue;

    const igual = limpa.indexOf("=");
    if (igual === -1) continue;

    const chave = limpa.slice(0, igual).trim();
    let valor = limpa.slice(igual + 1).trim();
    if (
      (valor.startsWith('"') && valor.endsWith('"')) ||
      (valor.startsWith("'") && valor.endsWith("'"))
    ) {
      valor = valor.slice(1, -1);
    }

    // Ambiente real ganha do arquivo: no Render as variáveis já estão lá, e um
    // .env esquecido no repositório não pode sobrescrever produção.
    if (process.env[chave] === undefined) {
      process.env[chave] = valor;
      lidas += 1;
    }
  }
  return lidas;
}

// ---------------------------------------------------------------------------
// Saída
// ---------------------------------------------------------------------------

const cor = process.stdout.isTTY
  ? { ok: "\x1b[32m", erro: "\x1b[31m", aviso: "\x1b[33m", fraco: "\x1b[90m", fim: "\x1b[0m" }
  : { ok: "", erro: "", aviso: "", fraco: "", fim: "" };

const resultados = [];

function titulo(t) {
  console.log(`\n${t}\n${"-".repeat(t.length)}`);
}

function ok(nome, detalhe) {
  resultados.push({ nome, estado: "ok" });
  console.log(`${cor.ok}  OK${cor.fim}     ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
}

function falha(nome, motivo, comoResolver) {
  resultados.push({ nome, estado: "falha" });
  console.log(`${cor.erro}  FALHA${cor.fim}  ${nome} — ${motivo}`);
  if (comoResolver) console.log(`${cor.fraco}         → ${comoResolver}${cor.fim}`);
}

function aviso(nome, motivo, comoResolver) {
  resultados.push({ nome, estado: "aviso" });
  console.log(`${cor.aviso}  AVISO${cor.fim}  ${nome} — ${motivo}`);
  if (comoResolver) console.log(`${cor.fraco}         → ${comoResolver}${cor.fim}`);
}

function pulado(nome, motivo) {
  resultados.push({ nome, estado: "pulado" });
  console.log(`${cor.fraco}  -      ${nome} — ${motivo}${cor.fim}`);
}

/** Nunca imprime credencial inteira: a saída daqui costuma virar print no chat. */
function mascarar(valor) {
  if (!valor) return "(vazio)";
  if (valor.length <= 10) return `${valor.slice(0, 2)}…(${valor.length} chars)`;
  return `${valor.slice(0, 6)}…${valor.slice(-4)} (${valor.length} chars)`;
}

/**
 * `fetch` que devolve a causa em vez de estourar.
 *
 * A distinção entre "não consegui perguntar" e "perguntei e recebi erro" é a
 * mesma que o worker faz com o gateway, e pelo mesmo motivo: DNS que não
 * resolve é problema de rede/URL, HTTP 401 é problema de credencial, e tratar
 * os dois como "falhou" manda a pessoa procurar no lugar errado.
 */
async function tentar(url, opcoes = {}) {
  try {
    const resposta = await fetch(url, {
      ...opcoes,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const texto = await resposta.text().catch(() => "");
    return { alcancado: true, status: resposta.status, ok: resposta.ok, texto };
  } catch (e) {
    const nome = e?.name ?? "";
    const causa = e?.cause?.code ?? "";
    const motivo =
      nome === "TimeoutError"
        ? `sem resposta em ${TIMEOUT_MS / 1000}s`
        : causa === "ENOTFOUND"
          ? "o host não existe (DNS não resolveu)"
          : causa === "EAI_AGAIN"
            ? "o DNS não respondeu — esta máquina está sem rede, ou atrás de um proxy"
            : causa === "ECONNREFUSED"
            ? "conexão recusada — nada escutando nessa porta"
            : causa === "CERT_HAS_EXPIRED"
              ? "certificado TLS expirado"
                : `${e?.message ?? String(e)}${causa ? ` (${causa})` : ""}`;
    return { alcancado: false, motivo };
  }
}

/** Primeira mensagem útil de um corpo de erro JSON, sem despejar o corpo todo. */
function mensagemDoCorpo(texto) {
  try {
    const j = JSON.parse(texto);
    const m = j?.error?.message ?? j?.message ?? j?.response?.message ?? j?.msg;
    if (typeof m === "string") return m;
    if (Array.isArray(m)) return m.join("; ");
  } catch {
    /* corpo não-JSON cai no recorte cru abaixo */
  }
  return texto ? texto.slice(0, 200).replace(/\s+/g, " ") : "";
}

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------

async function testarEvolution() {
  titulo("Evolution API (envio de WhatsApp)");

  const url = process.env.EVOLUTION_API_URL?.replace(/\/+$/, "");
  const chave = process.env.EVOLUTION_API_KEY;

  if (!url || !chave) {
    falha(
      "EVOLUTION_API_URL / EVOLUTION_API_KEY",
      "não preenchidas",
      "Sem elas todo envio falha um a um e a campanha anda marcando falha em cada contato.",
    );
    return;
  }

  console.log(`${cor.fraco}         url: ${url}   apikey: ${mascarar(chave)}${cor.fim}`);

  const r = await tentar(`${url}/instance/fetchInstances`, { headers: { apikey: chave } });

  if (!r.alcancado) {
    falha("Evolution alcançável", r.motivo, `Confira EVOLUTION_API_URL e se a VPS está no ar.`);
    return;
  }

  if (r.status === 401 || r.status === 403) {
    falha(
      "EVOLUTION_API_KEY",
      `o gateway respondeu HTTP ${r.status}`,
      "É a AUTHENTICATION_API_KEY do docker-compose da Evolution, não a chave de uma instância.",
    );
    return;
  }

  if (!r.ok) {
    falha("Evolution", `HTTP ${r.status} — ${mensagemDoCorpo(r.texto)}`, null);
    return;
  }

  ok("Evolution alcançável e chave aceita");

  // A lista de instâncias é o dado que mais dói faltar: canal cadastrado no
  // painel sem instância correspondente aqui é envio que falha em silêncio.
  let instancias;
  try {
    const j = JSON.parse(r.texto);
    instancias = Array.isArray(j) ? j : (j?.instances ?? []);
  } catch {
    aviso("Instâncias", "resposta não é JSON reconhecível", "Versão da Evolution muito diferente?");
    return;
  }

  if (instancias.length === 0) {
    aviso(
      "Instâncias",
      "nenhuma instância existe no gateway",
      "Crie o canal pela tela de Canais e leia o QR Code antes de disparar.",
    );
    return;
  }

  const resumo = instancias
    .map((i) => {
      const nome = i?.name ?? i?.instanceName ?? i?.instance?.instanceName ?? "?";
      const estado = i?.connectionStatus ?? i?.status ?? i?.instance?.state ?? "?";
      return `${nome}=${estado}`;
    })
    .join(", ");

  const conectadas = instancias.filter((i) => {
    const e = i?.connectionStatus ?? i?.status ?? i?.instance?.state;
    return e === "open" || e === "connected";
  }).length;

  if (conectadas === 0) {
    aviso(
      "Instâncias",
      `${instancias.length} cadastrada(s), nenhuma conectada — ${resumo}`,
      "Nenhum envio sai enquanto o WhatsApp não estiver pareado. Releia o QR Code.",
    );
  } else {
    ok("Instâncias", `${conectadas}/${instancias.length} conectada(s) — ${resumo}`);
  }

  return instancias;
}

/**
 * Manda uma mensagem de verdade pela primeira instância conectada.
 *
 * Vale mais que todos os testes acima somados: chave aceita e instância "open"
 * ainda deixam passar número mal formatado, instância pareada num aparelho sem
 * bateria e sessão que o WhatsApp derrubou sem avisar o gateway. O caminho só
 * está provado quando a mensagem chega.
 *
 * Usa exatamente o mesmo endpoint e o mesmo corpo de `provedorEvolution.enviar`
 * — um teste que fala com o gateway de um jeito diferente do worker prova o
 * caminho errado.
 */
async function testarEnvio(instancias, destino) {
  titulo("Envio de teste");

  const url = process.env.EVOLUTION_API_URL?.replace(/\/+$/, "");
  const chave = process.env.EVOLUTION_API_KEY;
  if (!url || !chave) return;

  if (!instancias?.length) {
    falha("Envio", "nenhuma instância no gateway para enviar", null);
    return;
  }

  const conectada = instancias.find((i) => {
    const e = i?.connectionStatus ?? i?.status ?? i?.instance?.state;
    return e === "open" || e === "connected";
  });

  if (!conectada) {
    falha("Envio", "nenhuma instância conectada", "Releia o QR Code na tela de Canais.");
    return;
  }

  const nome = conectada.name ?? conectada.instanceName ?? conectada.instance?.instanceName;

  // O `+` sai aqui pelo mesmo motivo que sai no provedor: o Baileys quer só
  // dígitos, e o `+` vira "número inexistente" em vez de erro de formato.
  const numero = destino.replace(/[^\d]/g, "");
  if (numero.length < 12) {
    falha(
      "Número de destino",
      `"${destino}" tem ${numero.length} dígitos`,
      "Use o formato internacional completo: +55 + DDD + número (ex.: +5511999999999).",
    );
    return;
  }

  console.log(`${cor.fraco}         instância: ${nome}   destino: ${numero}${cor.fim}`);

  const texto = `Teste do Disparoy — ${new Date().toLocaleString("pt-BR")}. Se você recebeu isto, o caminho de envio está funcionando.`;

  const r = await tentar(`${url}/message/sendText/${encodeURIComponent(nome)}`, {
    method: "POST",
    headers: { apikey: chave, "Content-Type": "application/json" },
    body: JSON.stringify({ number: numero, text: texto }),
  });

  if (!r.alcancado) {
    falha("Envio", r.motivo, null);
    return;
  }

  if (!r.ok) {
    falha(
      "Envio",
      `HTTP ${r.status} — ${mensagemDoCorpo(r.texto)}`,
      r.status === 400
        ? "Número inexistente no WhatsApp, ou a instância caiu depois da checagem acima."
        : null,
    );
    return;
  }

  let id;
  try {
    id = JSON.parse(r.texto)?.key?.id;
  } catch {
    /* o gateway aceitou; o id é só conveniência */
  }

  ok("Envio", `mensagem aceita pelo gateway${id ? ` (id ${id})` : ""}`);
  console.log(`${cor.fraco}         → confira o aparelho. Se não chegou, o problema está entre o${cor.fim}`);
  console.log(`${cor.fraco}           gateway e o WhatsApp, não no Disparoy.${cor.fim}`);
}

async function testarGroq() {
  titulo("Groq (botão 'Gerar variações')");

  const chave = process.env.GROQ_API_KEY;
  const modelo = process.env.GROQ_MODELO?.trim() || "llama-3.3-70b-versatile";

  if (!chave) {
    pulado("GROQ_API_KEY", "não preenchida — o botão responde 503 e escrever à mão continua igual");
    return;
  }

  console.log(`${cor.fraco}         chave: ${mascarar(chave)}   modelo: ${modelo}${cor.fim}`);

  if (!chave.startsWith("gsk_")) {
    aviso("Formato da chave", "não começa com 'gsk_'", "As chaves da Groq têm esse prefixo.");
  }

  const r = await tentar("https://api.groq.com/openai/v1/models", {
    headers: { Authorization: `Bearer ${chave}` },
  });

  if (!r.alcancado) {
    falha("Groq alcançável", r.motivo, "Firewall ou proxy bloqueando api.groq.com?");
    return;
  }

  if (r.status === 401) {
    falha(
      "GROQ_API_KEY",
      "recusada (HTTP 401)",
      "Gere outra em https://console.groq.com/keys — chave revogada não volta.",
    );
    return;
  }

  if (!r.ok) {
    falha("Groq", `HTTP ${r.status} — ${mensagemDoCorpo(r.texto)}`, null);
    return;
  }

  ok("Chave da Groq aceita");

  // O modelo é o que envelhece: o catálogo da Groq muda, e um modelo removido
  // vira 404 só na hora em que o operador clica em "Gerar variações".
  let ids = [];
  try {
    ids = (JSON.parse(r.texto)?.data ?? []).map((m) => m?.id).filter(Boolean);
  } catch {
    /* sem lista, o teste de geração abaixo ainda diz a verdade */
  }

  if (ids.length && !ids.includes(modelo)) {
    falha(
      `Modelo ${modelo}`,
      "não está na lista de modelos disponíveis para esta conta",
      `Troque GROQ_MODELO no .env. Disponíveis com 'llama' ou 'gpt-oss': ${
        ids.filter((i) => /llama|gpt-oss/.test(i)).join(", ") || "(nenhum)"
      }`,
    );
    return;
  }

  if (ids.length) ok(`Modelo ${modelo}`, "disponível");

  // Chave válida e modelo existente ainda dão erro se a conta não aceita
  // `response_format: json_object` nesse modelo — que é o formato de que o
  // gerador depende. Uma geração mínima de verdade é o único jeito de saber.
  const g = await tentar("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${chave}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelo,
      /*
       * A palavra "json" precisa aparecer nas mensagens.
       *
       * Com `response_format: json_object`, a Groq recusa a requisição inteira
       * se nenhuma mensagem mencionar json — HTTP 400, "'messages' must contain
       * the word 'json' in some form". O prompt real do gerador diz "objeto
       * JSON" e passa; este teste não dizia, e por isso acusava uma falha que
       * não existia: o diagnóstico reportava o botão "Gerar variações" como
       * quebrado enquanto ele funcionava normalmente.
       */
      messages: [{ role: "user", content: 'Responda em json: {"ok":true} e nada mais.' }],
      response_format: { type: "json_object" },
      max_completion_tokens: 32,
    }),
  });

  if (!g.alcancado) {
    falha("Geração de teste", g.motivo, null);
  } else if (g.status === 429) {
    aviso(
      "Geração de teste",
      "limite de uso atingido (HTTP 429)",
      "A chave funciona; a cota é que acabou. Confira https://console.groq.com/dashboard.",
    );
  } else if (!g.ok) {
    falha("Geração de teste", `HTTP ${g.status} — ${mensagemDoCorpo(g.texto)}`, null);
  } else {
    ok("Geração de teste", "o modelo respondeu em JSON");
  }
}

async function testarSupabase() {
  titulo("Supabase (dados)");

  const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !chave) {
    falha("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY", "não preenchidas", "A API não sobe sem elas.");
    return;
  }

  console.log(`${cor.fraco}         url: ${url}   service role: ${mascarar(chave)}${cor.fim}`);

  // `perfis` e não uma tabela qualquer: é a que o boot lê para garantir o admin
  // inicial, então se esta responde, o caminho crítico do boot responde.
  const r = await tentar(`${url}/rest/v1/perfis?select=id&limit=1`, {
    headers: { apikey: chave, Authorization: `Bearer ${chave}` },
  });

  if (!r.alcancado) {
    falha("Supabase alcançável", r.motivo, "Confira SUPABASE_URL.");
    return;
  }

  if (r.status === 401 || r.status === 403) {
    falha(
      "SUPABASE_SERVICE_ROLE_KEY",
      `HTTP ${r.status} — ${mensagemDoCorpo(r.texto)}`,
      "Project Settings > API > service_role. A anon key não serve: a API ignora RLS.",
    );
    return;
  }

  if (r.status === 404) {
    falha(
      "Tabela perfis",
      "não existe neste projeto",
      "As migrations em supabase/migrations ainda não rodaram neste banco.",
    );
    return;
  }

  if (!r.ok) {
    falha("Supabase", `HTTP ${r.status} — ${mensagemDoCorpo(r.texto)}`, null);
    return;
  }

  ok("Supabase respondendo com a service role");
}

async function testarBanco() {
  titulo("Postgres / fila (pg-boss)");

  const url = process.env.DATABASE_URL;
  if (!url) {
    falha(
      "DATABASE_URL",
      "não preenchida",
      "Sem fila o worker não roda: campanha é criada e nada sai.",
    );
    return;
  }

  let alvo;
  try {
    alvo = new URL(url);
  } catch {
    falha("DATABASE_URL", "não é uma URL válida", "Formato: postgresql://usuario:senha@host:porta/db");
    return;
  }

  console.log(
    `${cor.fraco}         host: ${alvo.hostname}:${alvo.port || "5432"}   usuário: ${alvo.username}${cor.fim}`,
  );

  // O erro mais caro do projeto e o mais silencioso: a porta 6543 é o pooler em
  // modo TRANSACTION, que não repassa LISTEN/NOTIFY nem advisory lock. A
  // conexão abre normalmente e o pg-boss é que quebra depois.
  if (alvo.port === "6543") {
    falha(
      "Porta 6543 (Transaction pooler)",
      "o pg-boss precisa de conexão de SESSÃO",
      "Use a porta 5432 (Connect > Session pooler). O usuário lá é postgres.<ref>, não postgres.",
    );
    return;
  }

  let Client;
  try {
    ({ Client } = require("pg"));
  } catch {
    pulado("Conexão", "módulo 'pg' não encontrado — rode `npm install` na raiz do repositório");
    return;
  }

  const cliente = new Client({
    connectionString: url,
    // O Supabase termina TLS com certificado de cadeia própria; sem isto o
    // teste falharia com erro de certificado num banco perfeitamente saudável.
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: TIMEOUT_MS,
  });

  try {
    await cliente.connect();
  } catch (e) {
    const msg = e?.message ?? String(e);
    const dica = /password authentication failed/i.test(msg)
      ? "Host e usuário certos, senha errada. Copie a string em Connect > Session pooler."
      : /ETIMEDOUT/i.test(msg)
        ? "Timeout. db.<ref>.supabase.co só publica IPv6 — use o Session pooler, que tem IPv4."
        : /ENOTFOUND/i.test(msg)
          ? "Host não resolveu. Confira a referência do projeto na string."
          : null;
    falha("Conexão com o Postgres", msg, dica);
    return;
  }

  try {
    const { rows } = await cliente.query("select current_database() as db, version() as v");
    ok("Conexão com o Postgres", `banco ${rows[0].db}`);

    // Prova direta de que a conexão é de sessão: em modo transaction este
    // advisory lock não sobrevive ao fim do statement e o LISTEN é recusado.
    await cliente.query("listen disparoy_diagnostico");
    const { rows: trava } = await cliente.query("select pg_try_advisory_lock(4242) as travou");
    if (trava[0].travou) {
      await cliente.query("select pg_advisory_unlock(4242)");
      ok("Conexão de sessão", "LISTEN/NOTIFY e advisory lock funcionam — o pg-boss vai subir");
    } else {
      aviso("Advisory lock", "não obtido", "Outra conexão pode estar segurando a mesma trava.");
    }

    const { rows: fila } = await cliente.query(
      "select count(*)::int as n from information_schema.schemata where schema_name = 'pgboss'",
    );
    if (fila[0].n === 0) {
      aviso(
        "Schema pgboss",
        "ainda não existe",
        "É criado sozinho no primeiro boot da API com a fila ligada. Normal antes disso.",
      );
    } else {
      ok("Schema pgboss", "já criado");
    }
  } catch (e) {
    falha("Consulta de verificação", e?.message ?? String(e), null);
  } finally {
    await cliente.end().catch(() => {});
  }
}

function testarWebhook() {
  titulo("Webhook de retorno (status de entrega e opt-out)");

  const publica = process.env.APP_URL_PUBLICA?.replace(/\/+$/, "");
  const segredo = process.env.EVOLUTION_WEBHOOK_SECRET;
  const gateway = process.env.EVOLUTION_API_URL ?? "";

  if (!segredo) {
    falha(
      "EVOLUTION_WEBHOOK_SECRET",
      "não preenchido",
      "O endpoint recusa tudo: os disparos saem e nenhum status volta. Gere com openssl rand -hex 32.",
    );
  } else if (segredo.length < 16) {
    falha("EVOLUTION_WEBHOOK_SECRET", "tem menos de 16 caracteres", "A API recusa subir assim.");
  } else {
    ok("EVOLUTION_WEBHOOK_SECRET", mascarar(segredo));
  }

  if (!publica) {
    falha(
      "APP_URL_PUBLICA",
      "não preenchida",
      "A instância é criada sem webhook nenhum — nenhum status volta.",
    );
    return;
  }

  const local = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(publica);
  const gatewayLocal = /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(gateway);

  // Endereço local só funciona se o gateway roda na MESMA máquina. Com a
  // Evolution numa VPS, o webhook é entregue no localhost dela e some.
  if (local && !gatewayLocal) {
    aviso(
      "APP_URL_PUBLICA",
      `${publica} é um endereço local, mas a Evolution está em ${gateway}`,
      "O gateway não alcança sua máquina: nenhum status de entrega volta e o opt-out " +
        "nunca chega. Para receber, exponha a API (ex.: `cloudflared tunnel --url " +
        "http://localhost:3333`) e ponha a URL gerada aqui. Só disparar continua funcionando.",
    );
  } else {
    ok("APP_URL_PUBLICA", `${publica}/api/webhooks/evolution`);
  }
}

// ---------------------------------------------------------------------------

async function principal() {
  const caminhoEnv = resolve(aqui, "..", ".env");
  const lidas = carregarEnv(caminhoEnv);
  console.log(
    lidas > 0
      ? `${cor.fraco}Lidas ${lidas} variáveis de ${caminhoEnv}${cor.fim}`
      : `${cor.fraco}Sem .env em ${caminhoEnv} — usando só o ambiente atual${cor.fim}`,
  );

  const argumentos = process.argv.slice(2);
  const posEnviar = argumentos.indexOf("--enviar");
  const destino = posEnviar === -1 ? null : argumentos[posEnviar + 1];

  if (posEnviar !== -1 && !destino) {
    console.error(
      "\n--enviar precisa do número: node scripts/diagnostico.mjs --enviar +5511999999999",
    );
    process.exit(2);
  }

  const instancias = await testarEvolution();
  if (destino) await testarEnvio(instancias, destino);
  await testarGroq();
  await testarSupabase();
  await testarBanco();
  testarWebhook();

  const falhas = resultados.filter((r) => r.estado === "falha");
  const avisos = resultados.filter((r) => r.estado === "aviso");

  titulo("Resumo");
  console.log(
    `  ${resultados.filter((r) => r.estado === "ok").length} ok, ` +
      `${avisos.length} aviso(s), ${falhas.length} falha(s)`,
  );

  if (falhas.length) {
    console.log(`\n${cor.erro}Impedem o sistema de funcionar:${cor.fim}`);
    for (const f of falhas) console.log(`  - ${f.nome}`);
  }
  if (avisos.length) {
    console.log(`\n${cor.aviso}Funciona, mas pela metade:${cor.fim}`);
    for (const a of avisos) console.log(`  - ${a.nome}`);
  }
  if (!falhas.length && !avisos.length) {
    console.log(`\n${cor.ok}Tudo verde. Suba a API e o worker.${cor.fim}`);
  }

  // Código de saída diferente de zero só para FALHA: aviso é estado conhecido
  // (webhook desligado em desenvolvimento, por exemplo) e não deve quebrar CI.
  process.exit(falhas.length ? 1 : 0);
}

principal().catch((e) => {
  console.error(`\n${cor.erro}O diagnóstico morreu antes de terminar:${cor.fim}`, e);
  process.exit(2);
});
