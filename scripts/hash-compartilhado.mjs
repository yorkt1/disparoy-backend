#!/usr/bin/env node
/**
 * Impressão digital de `shared/src`, para detectar divergência entre os repos.
 *
 * O `CLAUDE.md` dos dois lados manda copiar `shared/` byte a byte e conferir com
 * `diff -rq`. Isso depende de alguém lembrar, e o dia em que não lembrar produz
 * o pior tipo de bug: normalizar um telefone passa a dar resultado diferente na
 * API e no painel, os dois compilam, os dois passam nos testes, e a diferença só
 * aparece em produção com o contato de alguém.
 *
 * Conferir de dentro do CI é o problema: cada workflow clona UM repositório e
 * não tem o outro para comparar. Por isso a comparação não é entre os dois
 * clones e sim contra um hash versionado nos dois — se as duas cópias de
 * `shared/src` são iguais, o hash gravado nas duas também é, e um `shared/`
 * alterado sem o outro lado quebra o CI do repo alterado na hora.
 *
 * Consequência de propósito: mexer em `shared/` exige rodar `npm run
 * compartilhado:gravar` nos DOIS repos. É o passo que o processo manual pedia e
 * ninguém verificava.
 *
 *   node scripts/hash-compartilhado.mjs             imprime o hash calculado
 *   node scripts/hash-compartilhado.mjs --gravar    grava em shared/HASH.txt
 *   node scripts/hash-compartilhado.mjs --verificar compara e sai 1 se diferir
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FONTE = join(RAIZ, "shared", "src");
const ARQUIVO_HASH = join(RAIZ, "shared", "HASH.txt");

/** Caminhos em ordem estável: `readdir` não promete ordem, e hash precisa. */
function listar(diretorio) {
  const encontrados = [];
  for (const nome of readdirSync(diretorio).sort()) {
    const caminho = join(diretorio, nome);
    if (statSync(caminho).isDirectory()) encontrados.push(...listar(caminho));
    else encontrados.push(caminho);
  }
  return encontrados;
}

function calcular() {
  const hash = createHash("sha256");

  for (const caminho of listar(FONTE)) {
    // Separador POSIX: o mesmo arquivo é `whatsapp\falhas.ts` no Windows e
    // `whatsapp/falhas.ts` no runner do CI, e sem normalizar o hash mudaria
    // conforme o sistema operacional de quem gravou.
    const relativo = relative(FONTE, caminho).split("\\").join("/");

    /**
     * CRLF vira LF antes de entrar no hash.
     *
     * O `.gitattributes` grava LF no repositório mas deixa a cópia de trabalho
     * do Windows livre para usar CRLF. Sem normalizar, o hash gravado numa
     * máquina Windows nunca casaria com o recalculado no Ubuntu do CI, e a
     * verificação passaria a falhar sempre — que na prática é o mesmo que não
     * ter verificação nenhuma, porque em uma semana alguém a desliga.
     */
    const conteudo = readFileSync(caminho, "utf8").replace(/\r\n/g, "\n");

    // O nome entra junto com o conteúdo: sem ele, renomear um arquivo sem mudar
    // uma linha manteria o hash e a divergência passaria batida.
    hash.update(`${relativo}\u0000${conteudo}\u0000`);
  }

  return hash.digest("hex");
}

const calculado = calcular();
const modo = process.argv[2];

if (modo === "--gravar") {
  writeFileSync(ARQUIVO_HASH, `${calculado}\n`, "utf8");
  console.log(`shared/HASH.txt atualizado: ${calculado}`);
} else if (modo === "--verificar") {
  let gravado = "";
  try {
    gravado = readFileSync(ARQUIVO_HASH, "utf8").trim();
  } catch {
    console.error(
      "shared/HASH.txt não existe. Rode `npm run compartilhado:gravar` e versione o arquivo.",
    );
    process.exit(1);
  }

  if (gravado !== calculado) {
    console.error(
      `::error::shared/src não corresponde ao hash versionado.\n` +
        `  gravado:   ${gravado}\n` +
        `  calculado: ${calculado}\n\n` +
        `Se a mudança em shared/ é intencional, ela precisa estar NOS DOIS repositórios.\n` +
        `Copie shared/src para o outro repo, rode 'npm run compartilhado:gravar' em cada um\n` +
        `e versione o HASH.txt dos dois — os hashes têm de sair idênticos.`,
    );
    process.exit(1);
  }

  console.log(`shared/src confere: ${calculado}`);
} else {
  console.log(calculado);
}
