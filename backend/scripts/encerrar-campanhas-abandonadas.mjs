/**
 * Encerra campanhas que ficaram "em andamento" sem worker que as executasse.
 *
 * Existe por causa de um episódio concreto: seis campanhas ficaram em
 * "Em andamento" a 0% por dias — quatro de 09/08 e duas de 13/08 — porque o
 * worker nunca subiu. A fila tinha jobs em `created` esperando um consumidor, e
 * a tela não dava nenhum sinal de que nada estava saindo.
 *
 * O que ele faz, nesta ordem:
 *
 *   1. CANCELA os jobs vivos dessas campanhas na fila. É o passo mais
 *      importante e vem primeiro: se o worker subir com eles pendentes, ele
 *      dispara de verdade — mensagens reais, para pessoas reais, de uma
 *      campanha que o operador já deu como perdida.
 *   2. Marca as campanhas como `falhou`.
 *   3. Marca os contatos ainda pendentes como `bloqueado`, com o motivo.
 *   4. Registra na auditoria.
 *
 * Uso:
 *
 *   node backend/scripts/encerrar-campanhas-abandonadas.mjs            # só mostra
 *   node backend/scripts/encerrar-campanhas-abandonadas.mjs --aplicar  # escreve
 *
 * Sem `--aplicar` NÃO escreve nada — mesma escolha de `diagnostico.mjs`. Uma
 * ferramenta que altera campanha em produção não pode ter o modo destrutivo
 * como padrão.
 *
 * Critério: `em_andamento` sem NENHUM contato processado. Campanha com envio
 * parcial fica de fora de propósito — ali o worker realmente trabalhou, e
 * encerrar à força esconderia um problema diferente.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const APLICAR = process.argv.includes("--aplicar");

// Lê backend/.env sozinho; variáveis já no ambiente têm precedência, que é o
// que permite rodar isto no Shell do Render sem .env nenhum.
const ENV = path.join(AQUI, "..", ".env");
if (fs.existsSync(ENV)) {
  for (const linha of fs.readFileSync(ENV, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(linha.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL ausente. Preencha backend/.env.");
  process.exit(1);
}

const cliente = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await cliente.connect();

const MOTIVO = "Campanha abandonada: o worker de disparo não estava em execução.";

const { rows: alvos } = await cliente.query(`
  select c.id, c.nome, c.criada_em,
         count(cc.id)::int                                          as contatos,
         count(*) filter (where cc.status = 'pendente')::int         as pendentes
    from campanhas c
    left join campanha_contatos cc on cc.campanha_id = c.id
   where c.status = 'em_andamento'
   group by c.id, c.nome, c.criada_em
  having count(*) filter (where cc.processado_em is not null) = 0
   order by c.criada_em
`);

if (alvos.length === 0) {
  console.log("Nenhuma campanha abandonada. Nada a fazer.");
  await cliente.end();
  process.exit(0);
}

console.log(`${alvos.length} campanha(s) em andamento sem nenhum contato processado:\n`);
for (const a of alvos) {
  const quando = new Date(a.criada_em).toLocaleString("pt-BR");
  console.log(`  ${a.nome.padEnd(26)} ${quando}   ${a.pendentes}/${a.contatos} pendentes`);
}

const ids = alvos.map((a) => a.id);

const { rows: jobs } = await cliente.query(
  `select id, name, state, data from fila.job
    where state in ('created', 'active', 'retry')
      and (data->>'campanhaId') = any ($1::text[])`,
  [ids],
);

console.log(`\n${jobs.length} job(s) vivo(s) na fila para essas campanhas.`);
if (jobs.length > 0) {
  console.log("  Se o worker subir com eles pendentes, as mensagens SAEM de verdade.");
}

if (!APLICAR) {
  console.log("\n--- simulação: nada foi alterado ---");
  console.log("Rode de novo com --aplicar para executar.");
  await cliente.end();
  process.exit(0);
}

try {
  await cliente.query("begin");

  // 1. A fila primeiro. Marcar a campanha como falhou sem tirar o job da fila
  //    deixaria o worker disparando uma campanha que a tela diz estar encerrada.
  let jobsCancelados = 0;
  if (jobs.length > 0) {
    const r = await cliente.query(
      `update fila.job
          set state = 'cancelled', completed_on = now()
        where state in ('created', 'active', 'retry')
          and (data->>'campanhaId') = any ($1::text[])`,
      [ids],
    );
    jobsCancelados = r.rowCount;
  }

  const r2 = await cliente.query(
    `update campanhas
        set status = 'falhou', concluida_em = now()
      where id = any ($1::uuid[]) and status = 'em_andamento'`,
    [ids],
  );

  const r3 = await cliente.query(
    `update campanha_contatos
        set status = 'bloqueado', motivo = $2, processado_em = now()
      where campanha_id = any ($1::uuid[])
        and status in ('pendente', 'validando', 'enviando')`,
    [ids, MOTIVO],
  );

  for (const a of alvos) {
    await cliente.query(
      `insert into logs_auditoria
         (usuario_nome, acao, tipo_entidade, entidade_id, entidade_rotulo, detalhes)
       values ('Sistema', 'campanha.abandonada', 'campanha', $1, $2, $3::jsonb)`,
      [a.id, a.nome, JSON.stringify({ motivo: MOTIVO, contatosPendentes: a.pendentes })],
    );
  }

  await cliente.query("commit");

  console.log("\n--- aplicado ---");
  console.log(`  jobs cancelados na fila: ${jobsCancelados}`);
  console.log(`  campanhas marcadas como falhou: ${r2.rowCount}`);
  console.log(`  contatos bloqueados: ${r3.rowCount}`);
  console.log(`  registros de auditoria: ${alvos.length}`);
} catch (e) {
  await cliente.query("rollback").catch(() => undefined);
  console.error("\nFalhou, nada foi alterado:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await cliente.end();
}
