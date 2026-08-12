import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Marca o formato de cada pasta do build.
 *
 * Os dois builds emitem arquivos `.js`, e sem esses marcadores o Node usaria o
 * `type` do package.json raiz do pacote para os dois — lendo o ESM como
 * CommonJS (ou o contrário) e falhando em tempo de execução.
 */
const base = dirname(fileURLToPath(import.meta.url));

for (const [pasta, tipo] of [
  ["cjs", "commonjs"],
  ["esm", "module"],
]) {
  writeFileSync(
    join(base, "dist", pasta, "package.json"),
    `${JSON.stringify({ type: tipo }, null, 2)}\n`,
  );
}

console.log("dist/cjs e dist/esm marcados.");
