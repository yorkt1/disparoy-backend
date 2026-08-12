/**
 * Formatação e utilidades sem dependência de framework.
 *
 * O helper `cn()` de classes CSS não mora aqui de propósito: ele depende de
 * Tailwind e só faz sentido no frontend.
 */

const FUSO = "America/Sao_Paulo";

export function formatarDataHora(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: FUSO,
  }).format(new Date(iso));
}

export function formatarData(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeZone: FUSO }).format(
    new Date(iso),
  );
}

export function formatarNumero(valor: number): string {
  return new Intl.NumberFormat("pt-BR").format(valor);
}

export function formatarPercentual(valor: number, casas = 1): string {
  return `${new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: casas,
    maximumFractionDigits: casas,
  }).format(valor)}%`;
}

/** Formata E.164 brasileiro como +55 (11) 98765-4321. */
export function formatarTelefone(e164: string): string {
  const m = /^\+55(\d{2})(\d{4,5})(\d{4})$/.exec(e164);
  if (!m) return e164;
  return `+55 (${m[1]}) ${m[2]}-${m[3]}`;
}

/**
 * Id curto para uso no cliente — passos da sequência antes de salvar, chaves
 * de lista. Ids persistidos vêm do banco (`gen_random_uuid()`), não daqui.
 *
 * O acesso é via `globalThis` porque o pacote roda em Node e no navegador, e
 * declarar `lib: DOM` ou `@types/node` amarraria o domínio a um ambiente.
 */
export function gerarId(prefixo: string): string {
  const ambiente = globalThis as { crypto?: { randomUUID?: () => string } };
  const uuid = ambiente.crypto?.randomUUID?.();
  const aleatorio = uuid ? uuid.slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${prefixo}_${aleatorio}`;
}

/** Divisão protegida contra zero, devolvendo percentual 0..100. */
export function percentual(parte: number, total: number): number {
  if (!total) return 0;
  return Math.round((parte / total) * 1000) / 10;
}

export function slugify(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
