import { beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseService } from "../supabase/supabase.service";
import type { AuditoriaService } from "../auditoria/auditoria.service";
import type { FreioService } from "../comum/freio.service";
import { gerarHash } from "./senha";
import { SessaoService } from "./sessao.service";

/**
 * O login não pode dizer quais e-mails existem.
 *
 * A verificação é ESTRUTURAL, não cronometrada: medir tempo de parede num CI
 * compartilhado produz falha intermitente — a máquina engasga no meio de uma
 * medição e a suíte acusa um vazamento que não existe. O que se afere aqui é a
 * causa e não o sintoma: quantas vezes o scrypt foi derivado, e com quais
 * parâmetros de custo. Todo caminho de recusa precisa derivar o mesmo. Quem
 * voltar a sair mais cedo para e-mail inexistente zera a contagem daquele
 * caminho e quebra este arquivo.
 */
let derivacoes = 0;
let custos: string[] = [];

vi.mock("node:crypto", async (importarOriginal) => {
  const real = await importarOriginal<typeof import("node:crypto")>();
  return {
    ...real,
    scrypt: (...args: unknown[]) => {
      derivacoes += 1;
      const opcoes = args[3] as { N: number; r: number; p: number } | undefined;
      custos.push(opcoes ? `${opcoes.N}:${opcoes.r}:${opcoes.p}` : "sem-opcoes");
      return (real.scrypt as (...a: unknown[]) => void)(...args);
    },
  };
});

type LinhaFalsa = Record<string, unknown> | null;

/** Supabase de mentira: devolve a linha combinada e ignora o resto da consulta. */
function supabaseCom(linha: LinhaFalsa): SupabaseService {
  const consulta = {
    select: () => consulta,
    eq: () => consulta,
    maybeSingle: async () => ({ data: linha, error: null }),
  };
  return { tabela: () => consulta } as unknown as SupabaseService;
}

const auditoriaMuda = { registrar: async () => undefined } as unknown as AuditoriaService;

/**
 * Freio de mentira, com contadores.
 *
 * `bloqueioEmSegundos` a zero é o caminho normal — os testes de tempo constante
 * medem o login que CHEGA a conferir a senha, e uma conta trancada sai antes
 * disso de propósito.
 */
function freioFalso(bloqueioEmSegundos = 0) {
  const chamadas = { falhasRegistradas: 0, limpezas: 0 };
  const servico = {
    loginBloqueadoPor: async () => bloqueioEmSegundos,
    registrarFalhaDeLogin: async () => {
      chamadas.falhasRegistradas += 1;
    },
    limparFalhasDeLogin: async () => {
      chamadas.limpezas += 1;
    },
  } as unknown as FreioService;
  return { servico, chamadas };
}

const PERFIL = {
  id: "11111111-1111-1111-1111-111111111111",
  nome: "Fulano",
  email: "fulano@empresa.com",
  papel: "operator",
  ativo: true,
  empresa_id: null,
  criado_em: "2026-01-01T00:00:00.000Z",
};

/** Tenta entrar e devolve quantas vezes o scrypt rodou durante a tentativa. */
async function custoDaRecusa(linha: LinhaFalsa, senha: string): Promise<number> {
  const sessao = new SessaoService(supabaseCom(linha), auditoriaMuda, freioFalso().servico);
  derivacoes = 0;
  custos = [];
  await expect(sessao.entrar(PERFIL.email, senha, "1.2.3.4")).rejects.toThrow(
    "E-mail ou senha inválidos.",
  );
  return derivacoes;
}

describe("login não revela quais e-mails existem", () => {
  let hashReal = "";

  beforeAll(async () => {
    hashReal = await gerarHash("cavalo-bateria-grampo");
    // Uma tentativa fora da contagem: o hash descartável nasce sob demanda e é
    // memoizado por processo, e a chamada que o cria paga uma derivação a mais.
    // Sem este aquecimento o teste mediria o custo do boot, não o do login.
    await custoDaRecusa(null, "qualquer");
  });

  it("gasta o mesmo scrypt com e-mail inexistente, sem senha, desativado e senha errada", async () => {
    const inexistente = await custoDaRecusa(null, "cavalo-bateria-grampo");
    const semSenha = await custoDaRecusa({ ...PERFIL, senha_hash: null }, "cavalo-bateria-grampo");
    const desativado = await custoDaRecusa(
      { ...PERFIL, ativo: false, senha_hash: hashReal },
      "cavalo-bateria-grampo",
    );
    const senhaErrada = await custoDaRecusa(
      { ...PERFIL, senha_hash: hashReal },
      "cavalo-bateria-grampa",
    );

    // Zero em qualquer um significa saída antecipada — o vazamento de volta.
    expect(inexistente).toBeGreaterThan(0);
    expect([semSenha, desativado, senhaErrada]).toEqual([inexistente, inexistente, inexistente]);
  });

  it("usa os mesmos parâmetros de custo no hash descartável e no real", async () => {
    // Derivar o descartável com N menor devolveria mais rápido e recriaria a
    // diferença medível, mesmo com a contagem de chamadas igual.
    await custoDaRecusa(null, "cavalo-bateria-grampo");
    const semRegistro = [...custos];

    await custoDaRecusa({ ...PERFIL, senha_hash: hashReal }, "errada");
    expect(custos).toEqual(semRegistro);
  });

  it("linha corrompida no banco também custa o mesmo", async () => {
    // Um `senha_hash` truncado ou de outro algoritmo saía na hora antes daqui:
    // é um e-mail que EXISTE respondendo como se não existisse — mesmo oráculo,
    // outra porta.
    const base = await custoDaRecusa({ ...PERFIL, senha_hash: hashReal }, "errada");

    for (const corrompido of [
      "texto-solto",
      "bcrypt$2b$10$abc",
      "scrypt$16384$8$1$sal-sem-hash",
      "scrypt$x$y$z$c2Fs$aGFzaA",
      // N absurdo: o scrypt do Node recusa por estouro de memória, e recusa em
      // microssegundos — sem a faixa aceita em `senha.ts`, este é o caminho que
      // volta a responder rápido demais.
      "scrypt$1073741824$8$1$c2FsY29tZGV6c2Vpcw$aGFzaGNvbXRyaW50YWVkb2lzYnl0ZXNhcQ",
      // N que não é potência de dois: mesma recusa imediata.
      "scrypt$16385$8$1$c2FsY29tZGV6c2Vpcw$aGFzaGNvbXRyaW50YWVkb2lzYnl0ZXNhcQ",
    ]) {
      expect(await custoDaRecusa({ ...PERFIL, senha_hash: corrompido }, "errada")).toBe(base);
    }
  });
});

/**
 * O teto por IP do controller não cobre a lista de senhas comuns disparada
 * contra uma conta só, a partir de muitos IPs. Quem apagar a contagem por conta
 * devolve esse ataque ao sistema sem quebrar nenhum outro teste.
 */
describe("freio por conta", () => {
  it("recusa antes de consultar o perfil quando a conta está trancada", async () => {
    const freio = freioFalso(600);
    // Um supabase que EXPLODE se for consultado: a recusa precisa acontecer
    // antes do banco, senão a conta trancada continua custando uma consulta por
    // tentativa — que é justamente o que o atacante quer manter rodando.
    const supabaseProibido = {
      tabela: () => {
        throw new Error("o login consultou o banco com a conta trancada");
      },
    } as unknown as SupabaseService;

    const sessao = new SessaoService(supabaseProibido, auditoriaMuda, freio.servico);

    await expect(sessao.entrar(PERFIL.email, "qualquer", "1.2.3.4")).rejects.toThrow(
      /Tente de novo em 10 minutos/,
    );
    // Conta trancada não conta tentativa: se contasse, quem está bloqueado
    // renovaria o próprio bloqueio a cada tentativa e nunca sairia dele.
    expect(freio.chamadas.falhasRegistradas).toBe(0);
  });

  it("registra a falha para e-mail inexistente, não só para conta que existe", async () => {
    // Contar só o e-mail cadastrado faria "trancou" revelar "existe" — o mesmo
    // oráculo que a mensagem única e o scrypt em tempo constante evitam.
    const freio = freioFalso();
    const sessao = new SessaoService(supabaseCom(null), auditoriaMuda, freio.servico);

    await expect(sessao.entrar("ninguem@empresa.com", "errada", "1.2.3.4")).rejects.toThrow(
      "E-mail ou senha inválidos.",
    );
    expect(freio.chamadas.falhasRegistradas).toBe(1);
  });

  it("login que dá certo zera o histórico de falhas da conta", async () => {
    // Sem isto, erros de digitação espalhados pela semana somam até trancar
    // quem nunca foi atacado.
    const freio = freioFalso();

    // Este é o único teste do arquivo que chega a ASSINAR o token, e `assinar`
    // lê `ambiente()`. `vi.stubEnv` e não `process.env.X =` pelo motivo escrito
    // em `config/origens.test.ts`: escrito na mão o valor sobrevive ao arquivo e
    // o próximo a rodar no mesmo worker herda um ambiente que nunca pediu — foi
    // exatamente assim que `observabilidade.test.ts` passava sozinho e falhava
    // na suíte inteira. O `unstubEnvs` do `vitest.config.ts` desfaz isto sozinho.
    vi.stubEnv("SUPABASE_URL", "https://exemplo.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "chave-de-servico-de-teste-com-tamanho");
    vi.stubEnv("JWT_SECRET", "0".repeat(64));
    vi.stubEnv("DATABASE_URL", "postgres://usuario:senha@localhost:5432/postgres");
    vi.stubEnv("NODE_ENV", "test");

    const sessao = new SessaoService(
      supabaseCom({ ...PERFIL, senha_hash: await gerarHash("cavalo-bateria-grampo") }),
      auditoriaMuda,
      freio.servico,
    );

    await sessao.entrar(PERFIL.email, "cavalo-bateria-grampo", "1.2.3.4");
    expect(freio.chamadas.limpezas).toBe(1);
    expect(freio.chamadas.falhasRegistradas).toBe(0);
  });
});
