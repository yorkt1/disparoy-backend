#!/usr/bin/env node
/**
 * `npm audit` das dependências de produção, com exceção nominal e datada.
 *
 * `npm audit` sozinho não serve de portão aqui: o `xlsx` tem dois avisos altos
 * sem correção publicada no npm, então o comando cru falha em TODO commit. Um
 * passo que sempre falha é um passo que todo mundo aprende a ignorar, e aí o
 * aviso novo — o que teria correção — passa junto com o barulho.
 *
 * As duas saídas fáceis seriam `continue-on-error` (o portão vira enfeite) e
 * `--audit-level=critical` (varre o problema para debaixo do tapete e esconde
 * qualquer alto futuro). O caminho daqui é o do meio: cada exceção é escrita
 * com nome, motivo e data, e QUALQUER coisa fora da lista reprova. Quando o
 * `xlsx` sair do projeto ou voltar a publicar, apaga-se a entrada e o portão
 * fecha sozinho.
 */
import { execFileSync } from "node:child_process";

/**
 * Avisos aceitos conscientemente, com o porquê.
 *
 * Revisar quando a data passar — não para prorrogar no automático, e sim para
 * conferir se a razão ainda vale. Exceção sem prazo vira permanente.
 */
const EXCECOES = [
  {
    id: "GHSA-4r6h-8v6p-xvw6",
    pacote: "xlsx",
    motivo:
      "Prototype pollution no parser. Sem versão corrigida no npm (o upstream só " +
      "publica em cdn.sheetjs.com). Mitigado em backend/src/contatos/planilha.ts, " +
      "que vigia o Object.prototype em volta do parse e recusa o arquivo que o suja.",
    revisarEm: "2026-11-01",
  },
  {
    id: "GHSA-5pgg-2g8v-p4x9",
    pacote: "xlsx",
    motivo:
      "ReDoS no parser. Mesma ausência de versão corrigida. Mitigado pelo teto de " +
      "bytes antes do parse; o upload já exige sessão de operador autenticado.",
    revisarEm: "2026-11-01",
  },
];

const permitidos = new Set(EXCECOES.map((e) => e.id));

let saida = "";
try {
  saida = execFileSync("npm", ["audit", "--omit=dev", "--json"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
} catch (erro) {
  // `npm audit` sai com código diferente de zero justamente quando ENCONTRA
  // algo — que é o caso que interessa. O relatório vem no stdout mesmo assim.
  saida = erro.stdout ?? "";
  if (!saida) {
    console.error(`Não foi possível rodar o npm audit: ${erro.message}`);
    process.exit(1);
  }
}

const relatorio = JSON.parse(saida);
const graves = [];

for (const [nome, dado] of Object.entries(relatorio.vulnerabilities ?? {})) {
  if (!["high", "critical"].includes(dado.severity)) continue;

  for (const via of dado.via) {
    // `via` traz string (dependência transitiva) ou objeto (o aviso em si).
    if (typeof via === "string" || permitidos.has(via.url?.split("/").pop())) continue;
    graves.push({ pacote: nome, titulo: via.title, aviso: via.url });
  }
}

if (graves.length > 0) {
  console.error("::error::Dependência de produção com vulnerabilidade alta ou crítica:");
  for (const g of graves) console.error(`  ${g.pacote}: ${g.titulo} (${g.aviso})`);
  console.error(
    "\nCorrija com `npm audit fix`, troque a dependência, ou — se não houver correção —\n" +
      "acrescente a exceção em scripts/auditoria-dependencias.mjs com motivo e data.",
  );
  process.exit(1);
}

console.log("Nenhuma vulnerabilidade alta fora da lista de exceções.");
for (const e of EXCECOES) {
  console.log(`  Exceção ativa: ${e.pacote} ${e.id} — revisar em ${e.revisarEm}`);
}
