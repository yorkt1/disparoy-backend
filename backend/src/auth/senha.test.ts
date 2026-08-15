import { describe, expect, it } from "vitest";
import { conferirSenha, gerarHash } from "./senha";

/**
 * Senha é a única barreira entre a internet e a base inteira de contatos.
 * Estes testes existem para que uma "simplificação" no `senha.ts` não passe
 * despercebida: quase toda quebra aqui continua deixando o login funcionar.
 */
describe("hash de senha", () => {
  it("aceita a senha correta", async () => {
    const hash = await gerarHash("cavalo-bateria-grampo");
    expect(await conferirSenha("cavalo-bateria-grampo", hash)).toBe(true);
  });

  it("recusa a senha errada", async () => {
    const hash = await gerarHash("cavalo-bateria-grampo");
    expect(await conferirSenha("cavalo-bateria-grampa", hash)).toBe(false);
  });

  it("gera hashes diferentes para a mesma senha", async () => {
    // Sal por linha. Sem isso, duas contas com a mesma senha teriam o mesmo
    // hash, e um vazamento do banco entregaria as duas de uma vez.
    const [a, b] = await Promise.all([gerarHash("mesma"), gerarHash("mesma")]);
    expect(a).not.toBe(b);
  });

  it("guarda os parâmetros de custo junto do hash", async () => {
    // É o que permite encarecer o scrypt depois sem invalidar as senhas já
    // cadastradas: cada linha continua verificável com o custo com que nasceu.
    const [algoritmo, n, r, p] = (await gerarHash("x")).split("$");
    expect(algoritmo).toBe("scrypt");
    expect(Number(n)).toBeGreaterThanOrEqual(16384);
    expect(Number(r)).toBe(8);
    expect(Number(p)).toBe(1);
  });

  it("recusa em vez de estourar quando o hash é inútil", async () => {
    // Perfil sem senha definida, linha corrompida, formato de outro
    // algoritmo. Lançar aqui viraria 500 no login e contaria ao atacante que
    // aquele e-mail existe — a resposta certa é a mesma de senha errada.
    for (const armazenado of [
      null,
      "",
      "texto-solto",
      "bcrypt$2b$10$abc",
      "scrypt$16384$8$1$sal-sem-hash",
      "scrypt$x$y$z$c2Fs$aGFzaA",
    ]) {
      expect(await conferirSenha("qualquer", armazenado)).toBe(false);
    }
  });

  it("não confunde senha com prefixo da senha certa", async () => {
    // Comparação em tempo constante precisa continuar comparando o conteúdo
    // inteiro, não só até a primeira diferença.
    const hash = await gerarHash("senha-longa-de-verdade");
    expect(await conferirSenha("senha-longa-de-verdad", hash)).toBe(false);
    expect(await conferirSenha("senha-longa-de-verdadeX", hash)).toBe(false);
  });
});
