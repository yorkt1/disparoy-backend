import { ConflictException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Canal, MetodoPareamento } from "@disparoy/dominio";
import type { AuditoriaService } from "../auditoria/auditoria.service";
import type { LimitesService } from "../comum/limites.service";
import type { SupabaseService } from "../supabase/supabase.service";
import type { UsuarioAutenticado } from "../auth/auth.guard";
import type { WhatsappService } from "../whatsapp/whatsapp.service";

/**
 * O guarda do `reconectar`: derrubar sessão viva exige confirmação.
 *
 * Reconectar reinicia a instância no gateway. Num canal REALMENTE conectado
 * isso não conserta nada e corta a campanha que estiver enviando por ele — daí
 * o 409 que termina em "Confirme para prosseguir". `forcar` é essa confirmação.
 *
 * Estes testes existem porque o par nasceu quebrado: a API implementou o
 * `forcar` e o painel nunca o enviava, então o operador lia um pedido de
 * confirmação que não tinha como confirmar. O caminho ficou inalcançável e sem
 * teste nenhum dos dois lados, o que é como ele passou despercebido.
 *
 * O que se guarda aqui é a SEMÂNTICA das duas respostas — recusar sem
 * confirmação, prosseguir com ela. A tela é outra camada e tem os próprios
 * testes; o que amarra as duas é o campo `forcar` do `reconexaoCanalSchema`,
 * em `shared/`.
 */

vi.mock("../whatsapp/evolution-provider", () => ({
  estadoDaInstancia: vi.fn(),
  esquecerAgenda: vi.fn(),
  contatosDaInstancia: vi.fn(),
  excluirInstancia: vi.fn(),
  fotoDaInstancia: vi.fn(),
  numeroDaInstancia: vi.fn(),
}));

const USUARIO = {
  id: "11111111-1111-1111-1111-111111111111",
  nome: "Operador",
  papel: "admin",
  empresaId: "22222222-2222-2222-2222-222222222222",
} as UsuarioAutenticado;

const CANAL = {
  id: "33333333-3333-3333-3333-333333333333",
  nome: "Comercial",
  tipoConexao: "qrcode",
  instanciaEvolution: "disparoy-comercial",
} as Canal;

/**
 * Supabase mínimo: `reconectar` só escreve, e o resultado da escrita não muda
 * a decisão que está sendo testada. Um duplo completo aqui seria cenário para
 * outra coisa que este teste não afirma.
 */
function supabaseFalso() {
  const encadeado = {
    update: () => encadeado,
    eq: async () => ({ error: null }),
  };
  return { tabela: () => encadeado } as unknown as SupabaseService;
}

async function montar() {
  // Import dinâmico depois do `vi.mock`, e depois do `resetModules` do
  // `beforeEach`: o service captura `estadoDaInstancia` na avaliação do módulo.
  const { CanaisService } = await import("./canais.service.js");
  const provedor = await import("../whatsapp/evolution-provider.js");

  // Os parâmetros são declarados mesmo sem serem usados: sem eles o `vi.fn`
  // infere `calls` como tupla vazia, e a asserção sobre o SEGUNDO argumento
  // (`{ renovar: true }`) não compila — que é justamente o que ela precisa ver.
  const iniciarSessaoQr = vi.fn(
    async (
      _canal: Canal,
      _opcoes?: { metodo?: MetodoPareamento; numero?: string; renovar?: boolean },
    ) => ({
      metodo: "qrcode" as const,
      qr: "data:image/png;base64,zzz",
      codigo: null,
      expiraEm: new Date(Date.now() + 60_000).toISOString(),
    }),
  );

  const servico = new CanaisService(
    supabaseFalso(),
    { registrar: vi.fn() } as unknown as AuditoriaService,
    { iniciarSessaoQr } as unknown as WhatsappService,
    {} as LimitesService,
  );

  // `obter` é o carregamento do canal e a checagem de acesso — território de
  // outro teste. Aqui ele só precisa entregar um canal `qrcode`.
  vi.spyOn(servico, "obter").mockResolvedValue(CANAL);

  return { servico, iniciarSessaoQr, estadoDaInstancia: vi.mocked(provedor.estadoDaInstancia) };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("reconectar: sessão de pé exige confirmação", () => {
  /**
   * O caso que o painel não sabia responder. Sem `forcar`, com o gateway
   * dizendo `open`, a resposta é 409 e NADA é reiniciado.
   */
  it("recusa com 409 quando o gateway diz que a sessão está aberta", async () => {
    const { servico, iniciarSessaoQr, estadoDaInstancia } = await montar();
    estadoDaInstancia.mockResolvedValue("open");

    await expect(servico.reconectar(USUARIO, CANAL.id, {})).rejects.toBeInstanceOf(
      ConflictException,
    );

    // O que mais importa: recusar de verdade, e não recusar depois de já ter
    // derrubado a sessão. Se `iniciarSessaoQr` rodou, a campanha já foi cortada
    // e o 409 virou aviso tardio.
    expect(iniciarSessaoQr).not.toHaveBeenCalled();
  });

  /** A mensagem é o pedido de confirmação — é dela que a tela monta o botão. */
  it("o 409 diz o que vai acontecer e pede confirmação", async () => {
    const { servico, estadoDaInstancia } = await montar();
    estadoDaInstancia.mockResolvedValue("open");

    const erro = await servico.reconectar(USUARIO, CANAL.id, {}).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(erro).not.toBeNull();
    expect(erro?.message).toContain("já está conectado");
    expect(erro?.message).toContain("Confirme para prosseguir");
  });

  /** `forcar: true` é a confirmação chegando de volta. Agora derruba mesmo. */
  it("com forcar, reconecta mesmo estando conectado", async () => {
    const { servico, iniciarSessaoQr, estadoDaInstancia } = await montar();
    estadoDaInstancia.mockResolvedValue("open");

    const sessao = await servico.reconectar(USUARIO, CANAL.id, { forcar: true });

    expect(sessao.qr).toBeTruthy();
    expect(iniciarSessaoQr).toHaveBeenCalledOnce();
    // `renovar: true` sempre: quem confirmou quer pareamento NOVO, e sem isso o
    // gateway devolveria o mesmo código de antes.
    expect(iniciarSessaoQr.mock.calls[0]?.[1]).toMatchObject({ renovar: true });
  });

  /**
   * Canal caído não precisa de confirmação nenhuma — é o caminho comum, e pedir
   * confirmação nele treinaria o operador a clicar "sim" sem ler.
   */
  it("canal com sessão fechada reconecta direto, sem pedir nada", async () => {
    const { servico, iniciarSessaoQr, estadoDaInstancia } = await montar();
    estadoDaInstancia.mockResolvedValue("close");

    await servico.reconectar(USUARIO, CANAL.id, {});

    expect(iniciarSessaoQr).toHaveBeenCalledOnce();
  });

  /**
   * `indisponivel` é "não consegui perguntar", e o `ARQUITETURA-ATRIBUICAO-DE-FALHA`
   * é taxativo: nunca tratar isso como `close`. Aqui a consequência é o
   * contrário da usual e por isso vale fixar — sem confirmação do gateway de
   * que a sessão está `open`, não há sessão viva provada para proteger, e
   * barrar o reconectar deixaria o operador sem saída justamente quando o
   * gateway está com problema.
   */
  it("gateway mudo não vira pedido de confirmação", async () => {
    const { servico, iniciarSessaoQr, estadoDaInstancia } = await montar();
    estadoDaInstancia.mockResolvedValue("indisponivel");

    await servico.reconectar(USUARIO, CANAL.id, {});

    expect(iniciarSessaoQr).toHaveBeenCalledOnce();
  });
});
