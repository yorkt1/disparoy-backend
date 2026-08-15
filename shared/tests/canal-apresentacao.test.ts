import { describe, expect, it } from "vitest";
import type { Canal } from "../src/tipos";
import { apresentarCanal, statusDoGateway } from "../src/whatsapp/tipos";

const AGORA = new Date("2026-08-15T12:00:00.000Z").getTime();

function canal(p: Partial<Canal> = {}): Canal {
  return {
    id: "c1",
    nome: "Gui",
    numero: "+554891247324",
    instanciaEvolution: "disparoy_gui_av2o92",
    tipoConexao: "qrcode",
    status: "conectado",
    limiteDiario: 50,
    estagioAquecimento: 0,
    enviadasHoje: 0,
    solicitadoEm: "2026-08-09T22:41:29.000Z",
    conectadoEm: "2026-08-09T22:41:29.000Z",
    estadoGateway: "open",
    estadoVerificadoEm: "2026-08-15T11:59:00.000Z",
    ...p,
  };
}

describe("statusDoGateway", () => {
  it("traduz o que o gateway respondeu", () => {
    expect(statusDoGateway("open")).toBe("conectado");
    expect(statusDoGateway("close")).toBe("desconectado");
    expect(statusDoGateway("connecting")).toBe("desconectado");
  });

  it("devolve null quando não conseguimos perguntar", () => {
    // `null` é "não mexa em nada". Rebaixar o canal porque a NOSSA
    // infraestrutura não respondeu manda o cliente atrás de um QR que funciona.
    expect(statusDoGateway("indisponivel")).toBeNull();
  });
});

describe("apresentarCanal", () => {
  it("confirma quando foi verificado agora há pouco", () => {
    const a = apresentarCanal(canal(), AGORA);
    expect(a).toEqual({ status: "conectado", confianca: "confirmado", detalhe: "" });
  });

  it("nunca diz conectado sem número — é o caso do empreendebrazil", () => {
    // O número vem do `ownerJid` no pareamento. Sem número não houve
    // pareamento, e o cache está errado independente de quando foi escrito.
    const a = apresentarCanal(canal({ numero: null, conectadoEm: null }), AGORA);
    expect(a.status).toBe("aguardando_qr");
    expect(a.confianca).toBe("contraditorio");
  });

  it("a contradição vence mesmo com verificação recente", () => {
    const a = apresentarCanal(
      canal({ numero: null, estadoVerificadoEm: "2026-08-15T11:59:59.000Z" }),
      AGORA,
    );
    expect(a.confianca).toBe("contraditorio");
  });

  it("marca como não confirmado o que nunca foi verificado", () => {
    const a = apresentarCanal(canal({ estadoVerificadoEm: null }), AGORA);
    expect(a.confianca).toBe("nao_confirmado");
    expect(a.detalhe).toBe("nunca verificado");
    // O status gravado é preservado: não sabemos que está errado, só que não
    // foi conferido.
    expect(a.status).toBe("conectado");
  });

  it("envelhece a confirmação e diz há quanto tempo", () => {
    expect(apresentarCanal(canal({ estadoVerificadoEm: "2026-08-15T11:50:00.000Z" }), AGORA).detalhe)
      .toBe("verificado há 10 min");
    expect(apresentarCanal(canal({ estadoVerificadoEm: "2026-08-15T09:00:00.000Z" }), AGORA).detalhe)
      .toBe("verificado há 3 h");
    expect(apresentarCanal(canal({ estadoVerificadoEm: "2026-08-11T12:00:00.000Z" }), AGORA).detalhe)
      .toBe("verificado há 4 dias");
  });

  it("aceita a verificação dentro da validade", () => {
    // 4 min: ainda vale. 6 min: já não.
    expect(
      apresentarCanal(canal({ estadoVerificadoEm: "2026-08-15T11:56:00.000Z" }), AGORA).confianca,
    ).toBe("confirmado");
    expect(
      apresentarCanal(canal({ estadoVerificadoEm: "2026-08-15T11:54:00.000Z" }), AGORA).confianca,
    ).toBe("nao_confirmado");
  });

  it("desconectado também precisa de confirmação recente", () => {
    const a = apresentarCanal(
      canal({ status: "desconectado", numero: null, estadoVerificadoEm: null }),
      AGORA,
    );
    // Sem número mas TAMBÉM sem afirmar conexão: não é contradição, é só falta
    // de confirmação.
    expect(a.confianca).toBe("nao_confirmado");
    expect(a.status).toBe("desconectado");
  });
});
