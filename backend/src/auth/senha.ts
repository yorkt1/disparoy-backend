import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const derivar = promisify(scrypt) as (
  senha: string,
  sal: Buffer,
  tamanho: number,
  opcoes: { N: number; r: number; p: number },
) => Promise<Buffer>;

/**
 * Hash de senha com scrypt do próprio Node.
 *
 * scrypt em vez de bcrypt porque vem no runtime — uma dependência nativa a
 * menos para compilar no deploy — e porque é deliberadamente caro em memória,
 * o que encarece ataque com GPU muito mais do que só encarecer CPU.
 *
 * Formato armazenado: `scrypt$N$r$p$sal$hash`, tudo em base64url. Os parâmetros
 * viajam junto com o hash para que subir o custo depois não invalide as senhas
 * já cadastradas: cada linha continua sendo verificável com o custo com que foi
 * criada.
 */

const CUSTO = { N: 16384, r: 8, p: 1 };
const TAMANHO_HASH = 32;
const TAMANHO_SAL = 16;

/**
 * Faixas aceitas para os parâmetros que vêm GRAVADOS na linha.
 *
 * O custo é lido do banco, não fixado no código, e o scrypt do Node lança —
 * rápido, antes de derivar nada — quando N não é potência de dois ou quando
 * N·r·p estoura o teto de memória. Uma linha corrompida com `N=2^30` voltaria
 * em microssegundos, e é exatamente o tempo curto que o resto deste arquivo
 * existe para não vazar. Fora da faixa, a linha é tratada como inútil e o
 * trabalho é feito contra o hash descartável, ao custo normal.
 */
const N_MINIMO = 1 << 12;
const N_MAXIMO = 1 << 20;

export async function gerarHash(senha: string): Promise<string> {
  const sal = randomBytes(TAMANHO_SAL);
  const hash = await derivar(senha, sal, TAMANHO_HASH, CUSTO);
  return [
    "scrypt",
    CUSTO.N,
    CUSTO.r,
    CUSTO.p,
    sal.toString("base64url"),
    hash.toString("base64url"),
  ].join("$");
}

interface Registro {
  opcoes: { N: number; r: number; p: number };
  sal: Buffer;
  hash: Buffer;
}

/** Quebra o formato armazenado. `null` quando a linha não dá para conferir. */
function interpretar(armazenado: string | null): Registro | null {
  if (!armazenado) return null;

  const partes = armazenado.split("$");
  if (partes.length !== 6 || partes[0] !== "scrypt") return null;

  const [, n, r, p, salB64, hashB64] = partes;
  const opcoes = { N: Number(n), r: Number(r), p: Number(p) };
  if (!Number.isInteger(opcoes.N) || opcoes.N < N_MINIMO || opcoes.N > N_MAXIMO) return null;
  if ((opcoes.N & (opcoes.N - 1)) !== 0) return null;
  if (!Number.isInteger(opcoes.r) || opcoes.r < 1 || opcoes.r > 32) return null;
  if (!Number.isInteger(opcoes.p) || opcoes.p < 1 || opcoes.p > 16) return null;

  const sal = Buffer.from(salB64, "base64url");
  const hash = Buffer.from(hashB64, "base64url");
  // Tamanho do hash é o tamanho pedido ao scrypt: sem teto, uma linha
  // corrompida com um base64 gigante mandaria derivar megabytes.
  if (sal.length < 8 || sal.length > 64) return null;
  if (hash.length < 16 || hash.length > 64) return null;

  return { opcoes, sal, hash };
}

/**
 * Hash descartável, derivado uma vez com os parâmetros de custo ATUAIS.
 *
 * É contra ele que a conferência roda quando não há linha utilizável — e é o
 * que faz "e-mail não existe" custar o mesmo que "senha errada". Gerado sob
 * demanda, e não no import, para que o worker (que importa este arquivo mas
 * nunca confere senha) não pague scrypt no boot.
 *
 * A senha de origem é aleatória e nunca sai desta função: mesmo que o alvo
 * fosse conhecido, não haveria senha capaz de casar com ele.
 */
let descartavel: Promise<Registro> | null = null;

function registroDescartavel(): Promise<Registro> {
  descartavel ??= (async () => {
    const sal = randomBytes(TAMANHO_SAL);
    const hash = await derivar(randomBytes(32).toString("base64url"), sal, TAMANHO_HASH, CUSTO);
    return { opcoes: CUSTO, sal, hash };
  })();
  return descartavel;
}

/**
 * Confere a senha contra o hash armazenado.
 *
 * Nunca lança: hash corrompido, formato desconhecido ou perfil sem senha
 * devolvem `false`. Distinguir "hash inválido" de "senha errada" na resposta
 * contaria ao atacante qual e-mail existe.
 *
 * E não basta responder a mesma coisa — precisa levar o mesmo TEMPO. Antes
 * daqui, `armazenado` nulo saía na primeira linha, em microssegundos, enquanto
 * um e-mail cadastrado custava os ~100 ms do scrypt. A diferença é medível de
 * fora e transforma o login num oráculo de "este endereço existe": dá para
 * varrer uma lista de e-mails e sair com os que estão na base, sem acertar
 * senha nenhuma. Por isso TODO caminho de recusa deriva scrypt uma vez, com os
 * mesmos parâmetros de custo — o descartável quando não há registro válido, o
 * registro real quando há.
 */
export async function conferirSenha(senha: string, armazenado: string | null): Promise<boolean> {
  // O descartável é resolvido SEMPRE, mesmo quando há registro bom. Ele é
  // gerado uma vez por processo; produzi-lo só dentro do ramo de recusa faria a
  // primeira recusa depois de cada deploy custar dois scrypts contra o um de um
  // login legítimo — o mesmo vazamento, de volta pela porta dos fundos.
  const reserva = await registroDescartavel();
  const registro = interpretar(armazenado);
  const alvo = registro ?? reserva;

  let confere = false;
  try {
    const obtido = await derivar(senha, alvo.sal, alvo.hash.length, alvo.opcoes);
    // Comparação em tempo constante: `===` vazaria o tamanho do prefixo
    // correto pelo tempo de resposta.
    confere = obtido.length === alvo.hash.length && timingSafeEqual(obtido, alvo.hash);
  } catch {
    confere = false;
  }

  // `registro === null` é sempre recusa, aconteça o que acontecer na comparação
  // acima: ali o alvo era o descartável, não a senha de ninguém.
  return registro !== null && confere;
}

/**
 * Senhas que não podem entrar, por mais que caibam no mínimo de caracteres.
 *
 * O comprimento mínimo sozinho aceita `123456` e `senha1`, que são as primeiras
 * de qualquer lista de força bruta — o teto de tentativas do login atrasa o
 * ataque, não o impede, e um acesso de operador aqui abre a base inteira de
 * contatos. A lista é curta de propósito: recusar o óbvio custa nada, e
 * exigência de símbolo/maiúscula empurra a pessoa para `Senha@123`, que é pior
 * do que a frase longa que ela teria escolhido sozinha.
 */
const SENHAS_OBVIAS = new Set([
  "123456",
  "1234567",
  "12345678",
  "123456789",
  "1234567890",
  "senha",
  "senha123",
  "password",
  "password1",
  "password123",
  "qwerty",
  "qwerty123",
  "abc123",
  "admin",
  "admin123",
  "disparoy",
  "disparoy123",
  "mudar123",
  "trocar123",
  "whatsapp",
  "iloveyou",
  "111111",
  "000000",
]);

/**
 * Recusa a senha quando ela é adivinhável. Devolve o motivo, ou `null` se passa.
 *
 * Roda no servidor mesmo com o schema do domínio já validando comprimento: o
 * schema é compartilhado com o painel e vale como conveniência de formulário,
 * não como controle — quem posta direto na API não passa por ele.
 */
export function motivoSenhaFraca(
  senha: string,
  identidade: { email?: string; nome?: string } = {},
): string | null {
  const limpa = senha.trim();

  if (SENHAS_OBVIAS.has(limpa.toLowerCase())) {
    return "Esta senha está entre as mais usadas do mundo. Escolha outra.";
  }

  // Sequência de um caractere só passa em qualquer regra de comprimento.
  if (limpa.length > 0 && new Set(limpa).size === 1) {
    return "A senha não pode ser o mesmo caractere repetido.";
  }

  const pedacos = [
    identidade.email?.split("@")[0] ?? "",
    ...(identidade.nome ?? "").split(/\s+/),
  ]
    .map((p) => p.trim().toLowerCase())
    // Pedaço curto casaria com metade das senhas legítimas ("Ana" dentro de
    // qualquer frase) e recusaria senha boa sem motivo.
    .filter((p) => p.length >= 4);

  const alvo = limpa.toLowerCase();
  if (pedacos.some((p) => alvo.includes(p))) {
    return "A senha não pode conter o seu nome nem o seu e-mail.";
  }

  return null;
}
