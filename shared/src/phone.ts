/**
 * Normalização de números para E.164, com as regras específicas do Brasil.
 *
 * O caso chato: celulares brasileiros ganharam um "9" na frente em 2012, mas
 * planilhas antigas ainda trazem números de 8 dígitos. Fixos continuam com 8.
 * A heurística usada aqui é a mesma que a Meta aplica: 8 dígitos começando em
 * 6-9 é celular legado e recebe o nono dígito.
 */

export const DDDS_VALIDOS = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28, 31, 32, 33, 34, 35, 37, 38, 41, 42, 43,
  44, 45, 46, 47, 48, 49, 51, 53, 54, 55, 61, 62, 63, 64, 65, 66, 67, 68, 69, 71, 73, 74, 75, 77,
  79, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

export type MotivoInvalido =
  | "vazio"
  | "curto_demais"
  | "longo_demais"
  | "ddd_invalido"
  | "formato_invalido";

export type ResultadoNormalizacao =
  | { valido: true; e164: string; ddd: number; pais: string }
  | { valido: false; motivo: MotivoInvalido };

const MENSAGENS: Record<MotivoInvalido, string> = {
  vazio: "Número em branco",
  curto_demais: "Número curto demais",
  longo_demais: "Número longo demais",
  ddd_invalido: "DDD inexistente",
  formato_invalido: "Formato não reconhecido",
};

export function descreverMotivo(motivo: MotivoInvalido): string {
  return MENSAGENS[motivo];
}

/**
 * Converte entrada livre em E.164.
 * Aceita "11987654321", "(11) 98765-4321", "+55 11 98765-4321", "5511987654321".
 *
 * @param paisPadrao DDI assumido quando o número não traz código de país.
 */
export function normalizarTelefone(entrada: string, paisPadrao = "55"): ResultadoNormalizacao {
  const bruto = (entrada ?? "").trim();
  if (!bruto) return { valido: false, motivo: "vazio" };

  const tinhaMais = bruto.startsWith("+");
  let digitos = bruto.replace(/\D/g, "");
  if (!digitos) return { valido: false, motivo: "formato_invalido" };

  // Números internacionais não-brasileiros: aceita como veio, sem regra de DDD.
  if (tinhaMais && !digitos.startsWith(paisPadrao)) {
    if (digitos.length < 8) return { valido: false, motivo: "curto_demais" };
    if (digitos.length > 15) return { valido: false, motivo: "longo_demais" };
    return { valido: true, e164: `+${digitos}`, ddd: 0, pais: digitos.slice(0, 2) };
  }

  // Remove o DDI 55 quando presente, para trabalhar só com DDD + assinante.
  if (digitos.startsWith("55") && digitos.length >= 12) {
    digitos = digitos.slice(2);
  }

  if (digitos.length < 10) return { valido: false, motivo: "curto_demais" };
  if (digitos.length > 11) return { valido: false, motivo: "longo_demais" };

  const ddd = Number(digitos.slice(0, 2));
  if (!DDDS_VALIDOS.has(ddd)) return { valido: false, motivo: "ddd_invalido" };

  let assinante = digitos.slice(2);

  // Celular legado de 8 dígitos (6-9 na primeira posição) recebe o nono dígito.
  if (assinante.length === 8 && /^[6-9]/.test(assinante)) {
    assinante = `9${assinante}`;
  }

  if (assinante.length === 9 && !/^9/.test(assinante)) {
    return { valido: false, motivo: "formato_invalido" };
  }

  return { valido: true, e164: `+55${ddd}${assinante}`, ddd, pais: "55" };
}

/**
 * Normaliza uma lista removendo duplicatas pelo E.164 final — dois formatos
 * diferentes do mesmo número contam como um contato só.
 */
export function normalizarLista(entradas: string[], paisPadrao = "55") {
  const vistos = new Set<string>();
  const validos: { e164: string; original: string }[] = [];
  const invalidos: { original: string; motivo: MotivoInvalido }[] = [];
  let duplicados = 0;

  for (const entrada of entradas) {
    const r = normalizarTelefone(entrada, paisPadrao);
    if (!r.valido) {
      invalidos.push({ original: entrada, motivo: r.motivo });
      continue;
    }
    if (vistos.has(r.e164)) {
      duplicados += 1;
      continue;
    }
    vistos.add(r.e164);
    validos.push({ e164: r.e164, original: entrada });
  }

  return { validos, invalidos, duplicados };
}

/** Quebra um bloco colado manualmente em números individuais. */
export function separarNumerosColados(texto: string): string[] {
  return texto
    .split(/[\n,;]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}
