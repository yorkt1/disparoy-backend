// ============================================================================
// Lint do monorepo — `shared/` e `backend/`.
//
// Espelha o `eslint.config.mjs` do repositório do painel na parte que os dois
// compartilham. `shared/` é copiado byte a byte entre os dois: regra de lint
// diferente aqui produziria arquivo que passa de um lado e falha do outro,
// exatamente o problema que o `shared/HASH.txt` existe para impedir.
//
// O que NÃO vem de lá são as regras de React (hooks, jsx-a11y, react-refresh):
// não há componente neste repositório.
// ============================================================================
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/dist-worker/**", "**/node_modules/**", "**/coverage/**", "**/*.mjs"] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.node },
    },
    rules: {
      // Parâmetro/variável iniciado por `_` é descarte intencional — o padrão
      // usado no repositório para argumento que a assinatura exige e o corpo
      // não usa.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      /**
       * `any` é erro, não aviso.
       *
       * A API é tipada a partir de `@disparoy/dominio`, e um `any` solto apaga
       * justamente a checagem que garante que backend e painel concordam sobre
       * o formato da resposta.
       */
      "@typescript-eslint/no-explicit-any": "error",
    },
  },

  // Testes encenam entradas malformadas de propósito; exigir tipagem exata
  // neles obrigaria a duplicar os tipos do domínio só para descrever o que é
  // inválido.
  {
    files: ["**/*.test.ts", "**/*.spec.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
