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

/**
 * Confere a senha contra o hash armazenado.
 *
 * Nunca lança: hash corrompido, formato desconhecido ou perfil sem senha
 * devolvem `false`. Distinguir "hash inválido" de "senha errada" na resposta
 * contaria ao atacante qual e-mail existe.
 */
export async function conferirSenha(senha: string, armazenado: string | null): Promise<boolean> {
  if (!armazenado) return false;

  const partes = armazenado.split("$");
  if (partes.length !== 6 || partes[0] !== "scrypt") return false;

  const [, n, r, p, salB64, hashB64] = partes;
  const opcoes = { N: Number(n), r: Number(r), p: Number(p) };
  if (!Number.isFinite(opcoes.N) || !Number.isFinite(opcoes.r) || !Number.isFinite(opcoes.p)) {
    return false;
  }

  try {
    const esperado = Buffer.from(hashB64, "base64url");
    const obtido = await derivar(senha, Buffer.from(salB64, "base64url"), esperado.length, opcoes);
    // Comparação em tempo constante: `===` vazaria o tamanho do prefixo
    // correto pelo tempo de resposta.
    return obtido.length === esperado.length && timingSafeEqual(obtido, esperado);
  } catch {
    return false;
  }
}
