import { describe, expect, it } from "vitest";
import { campanhaEdicaoSchema } from "../src/schemas";

/**
 * Agendamento no passado, na EDIÇÃO.
 *
 * A criação já recusava data vencida; a edição não recusava nada. A diferença
 * produzia uma campanha agendada para um horário que já foi: ela não dispara,
 * fica "agendada" na tela como se fosse sair, e só meia hora depois a
 * manutenção a expira. Meia hora em que o operador acha que está a caminho.
 *
 * O caminho real era mais silencioso ainda: a tela de edição não tem campo de
 * data e devolvia o valor que tinha lido. Abrir às 9:30 uma campanha marcada
 * para 9:11 e salvar qualquer outra coisa regravava 9:11 — já vencido.
 */
describe("campanhaEdicaoSchema — agendamento", () => {
  const daquiAUmaHora = new Date(Date.now() + 3_600_000).toISOString();
  const umaHoraAtras = new Date(Date.now() - 3_600_000).toISOString();

  it("recusa data que já passou", () => {
    const r = campanhaEdicaoSchema.safeParse({ agendadaPara: umaHoraAtras });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toMatch(/já passou/i);
      expect(r.error.issues[0].path).toEqual(["agendadaPara"]);
    }
  });

  it("aceita data futura", () => {
    expect(campanhaEdicaoSchema.safeParse({ agendadaPara: daquiAUmaHora }).success).toBe(true);
  });

  /*
   * O caso comum, e o que impede a correção de virar um bloqueio: a tela de
   * edição OMITE o campo, porque não oferece controle de data. Campo ausente
   * significa "não mexa no agendamento", e precisa continuar passando mesmo
   * quando o agendamento gravado já venceu — senão editar o texto de uma
   * campanha atrasada passaria a ser impossível.
   */
  it("aceita o campo omitido, que é como a tela de edição salva", () => {
    expect(campanhaEdicaoSchema.safeParse({ nome: "Campanha de teste" }).success).toBe(true);
  });

  it("aceita null, que é o pedido explícito de desagendar", () => {
    expect(campanhaEdicaoSchema.safeParse({ agendadaPara: null }).success).toBe(true);
  });

  /*
   * A folga de um minuto é a mesma da criação: sem ela, "agendar para agora"
   * seria recusado pelo tempo que a própria requisição leva para chegar.
   */
  it("aceita agora mesmo, dentro da folga de um minuto", () => {
    const agora = new Date(Date.now() - 5_000).toISOString();
    expect(campanhaEdicaoSchema.safeParse({ agendadaPara: agora }).success).toBe(true);
  });
});
