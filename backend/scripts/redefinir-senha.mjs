/**
 * Redefine a senha de um perfil pela linha de comando.
 *
 * A saída de emergência do sistema. Todo acesso é criado por um admin, e o
 * admin que esquece a própria senha não tem caminho nenhum pelo produto:
 * `ADMIN_SENHA` no ambiente só vale na criação da conta e é ignorada depois.
 * Sem isto aqui, a resposta para "esqueci a senha do admin" seria mexer na
 * tabela `perfis` na mão, colando um hash scrypt gerado sabe-se lá como.
 *
 * Uso — no Shell do serviço no Render, ou localmente com o .env carregado:
 *
 *   node scripts/redefinir-senha.mjs alguem@empresa.com "nova senha aqui"
 *
 * Precisa de SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no ambiente, que é o que
 * a API já tem. Roda com o `dist/` compilado e usa só dependências de
 * PRODUÇÃO — o Render não instala as de desenvolvimento no runtime, então
 * `tsx` e afins não existem lá.
 *
 * Não cria perfil: só troca a senha de quem já existe. Criar acesso é ação de
 * admin, com auditoria, e não deve ter atalho por linha de comando.
 */
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const aqui = dirname(fileURLToPath(import.meta.url));

const [email, novaSenha] = process.argv.slice(2);

if (!email || !novaSenha) {
  console.error(
    'Uso: node scripts/redefinir-senha.mjs <email> "<nova senha>"\n\n' +
      "A senha entre aspas, ou o shell come os espaços.",
  );
  process.exit(1);
}

if (novaSenha.length < 8) {
  console.error("A senha precisa ter pelo menos 8 caracteres.");
  process.exit(1);
}

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "Faltam SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no ambiente.\n" +
      "No Render elas já existem no serviço; localmente, carregue o backend/.env.",
  );
  process.exit(1);
}

/**
 * O hash vem do código compilado, não de uma reimplementação aqui.
 *
 * Duplicar os parâmetros do scrypt neste arquivo seria a maneira mais fácil de
 * gerar um hash que o login não reconhece — e o sintoma apareceria só na hora
 * de entrar, com a senha "certa" sendo recusada.
 */
const caminhoSenha = resolve(aqui, "../dist/auth/senha.js");
let gerarHash;
try {
  ({ gerarHash } = require(caminhoSenha));
} catch {
  console.error(
    `Não encontrei ${caminhoSenha}.\n` +
      "Rode `npm run build` antes (no Render o dist/ já está lá depois do deploy).",
  );
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const alvo = email.trim().toLowerCase();

const { data: perfil, error: erroBusca } = await db
  .from("perfis")
  .select("id, nome, email, papel, ativo")
  .eq("email", alvo)
  .maybeSingle();

if (erroBusca) {
  console.error(`Falha ao consultar o perfil: ${erroBusca.message}`);
  process.exit(1);
}

if (!perfil) {
  console.error(`Nenhum perfil com o e-mail ${alvo}.`);
  process.exit(1);
}

const { error: erroGravacao } = await db
  .from("perfis")
  .update({ senha_hash: await gerarHash(novaSenha) })
  .eq("id", perfil.id);

if (erroGravacao) {
  console.error(`Falha ao gravar a nova senha: ${erroGravacao.message}`);
  process.exit(1);
}

/**
 * Registrado na auditoria como qualquer outra troca de senha.
 *
 * Redefinição por linha de comando é exatamente o evento que alguém vai querer
 * encontrar depois — deixá-lo fora da trilha criaria um jeito silencioso de
 * assumir uma conta.
 */
await db.from("logs_auditoria").insert({
  usuario_id: perfil.id,
  usuario_nome: perfil.nome,
  acao: "usuario.senha_redefinida",
  tipo_entidade: "usuario",
  entidade_id: perfil.id,
  entidade_rotulo: `${perfil.nome} <${perfil.email}>`,
  detalhes: { viaLinhaDeComando: true },
});

console.log(`Senha de ${perfil.nome} <${perfil.email}> redefinida.`);

if (!perfil.ativo) {
  // Senha nova não reativa ninguém: o login recusa perfil desativado antes de
  // olhar a senha. Melhor avisar agora do que deixar a pessoa tentando entrar.
  console.warn("Atenção: este acesso está DESATIVADO. Reative-o pelo painel para poder entrar.");
}

process.exit(0);
