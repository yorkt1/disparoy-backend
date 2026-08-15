import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import type { UsuarioAutenticado } from "../auth/auth.guard";
import { empresaParaEscrita, noEscopo } from "./escopo";

function usuario(empresaId: string | null): UsuarioAutenticado {
  return { id: "u1", email: "a@b.c", nome: "Fulano", papel: "operator", empresaId };
}

/** Espião no formato mínimo que `noEscopo` usa do builder do supabase-js. */
function consultaFalsa() {
  const chamadas: { coluna: string; valor: string }[] = [];
  const alvo = {
    chamadas,
    eq(coluna: string, valor: string) {
      chamadas.push({ coluna, valor });
      return alvo;
    },
  };
  return alvo;
}

describe("noEscopo", () => {
  it("filtra pela empresa do usuário", () => {
    const c = consultaFalsa();
    noEscopo(c, usuario("empresa-a"));
    expect(c.chamadas).toEqual([{ coluna: "empresa_id", valor: "empresa-a" }]);
  });

  it("não filtra a conta global", () => {
    // `empresaId: null` é o acesso de administração. Filtrar por null aqui não
    // daria "vê tudo", daria "não vê nada" — `.eq(col, null)` não casa com
    // linha alguma no PostgREST.
    const c = consultaFalsa();
    noEscopo(c, usuario(null));
    expect(c.chamadas).toEqual([]);
  });

  it("devolve o próprio builder, para continuar encadeando", () => {
    const c = consultaFalsa();
    expect(noEscopo(c, usuario("empresa-a"))).toBe(c);
    expect(noEscopo(c, usuario(null))).toBe(c);
  });
});

describe("empresaParaEscrita", () => {
  it("devolve a empresa do usuário", () => {
    expect(empresaParaEscrita(usuario("empresa-a"))).toBe("empresa-a");
  });

  it("recusa a conta global em vez de escolher uma empresa por ela", () => {
    // Qualquer palpite aqui — a empresa padrão, a primeira da lista — grava
    // dado de cliente numa empresa que não é a dele, em silêncio e para sempre.
    expect(() => empresaParaEscrita(usuario(null))).toThrow(BadRequestException);
  });
});
