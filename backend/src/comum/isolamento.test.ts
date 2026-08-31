import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { beforeEach, describe, expect, it } from "vitest";
import { CampanhasService } from "../campanhas/campanhas.service";
import { CanaisService } from "../canais/canais.service";
import { UsuariosService } from "../usuarios/usuarios.service";
import type { AuditoriaService } from "../auditoria/auditoria.service";
import type { FilaService } from "../fila/fila.service";
import type { SupabaseService } from "../supabase/supabase.service";
import type { WhatsappService } from "../whatsapp/whatsapp.service";
import type { UsuarioAutenticado } from "../auth/auth.guard";
import type { LimitesService } from "./limites.service";

/**
 * Isolamento entre duas empresas, exercitando os SERVIÇOS de verdade.
 *
 * Estes testes existem porque a API roda com a service role e ignora RLS: o
 * filtro por empresa feito no NestJS não tem segunda linha de defesa no banco.
 * Um `.eq("empresa_id", ...)` que some de um caminho não quebra nada visível —
 * a tela do dono continua idêntica —, e o defeito só aparece quando um cliente
 * lê, ou escreve, dentro de outro.
 *
 * Por isso o alvo aqui é o serviço, e não `noEscopo` (que `escopo.test.ts` já
 * cobre em separado): o que falhou de verdade não foi a função de escopo, foi
 * o caminho que se esqueceu de chamá-la.
 *
 * O dublê do Supabase abaixo cobre só o subconjunto do builder que estes
 * caminhos usam. Ele não tenta ser um Postgres — é um índice em memória que
 * aplica os `eq`/`is`/`neq` acumulados, que é exatamente o que precisa ser
 * verificado: se o filtro de empresa foi para a consulta ou não.
 */

const EMPRESA_A = "11111111-1111-1111-1111-111111111111";
const EMPRESA_B = "22222222-2222-2222-2222-222222222222";

type Registro = Record<string, unknown>;

interface Banco {
  campanhas: Registro[];
  canais: Registro[];
  perfis: Registro[];
  canal_membros: Registro[];
  campanha_canais: Registro[];
  logs_auditoria: Registro[];
}

/** Um canal completo o bastante para `paraCanal` não quebrar. */
function canal(id: string, empresaId: string, nome: string): Registro {
  return {
    id,
    nome,
    numero: "+5511900000000",
    instancia_evolution: `disparoy_${nome}_abc123`,
    tipo_conexao: "qrcode",
    status: "conectado",
    limite_diario: null,
    estagio_aquecimento: 1,
    enviadas_hoje: 0,
    solicitado_em: "2026-01-01T00:00:00.000Z",
    conectado_em: "2026-01-01T00:00:00.000Z",
    meta_phone_number_id: null,
    estado_gateway: "open",
    estado_verificado_em: "2026-01-01T00:00:00.000Z",
    foto_url: null,
    empresa_id: empresaId,
  };
}

function perfil(id: string, empresaId: string | null, papel: "admin" | "operator"): Registro {
  return {
    id,
    nome: `Perfil ${id}`,
    email: `${id}@exemplo.com`,
    papel,
    ativo: true,
    criado_em: "2026-01-01T00:00:00.000Z",
    senha_hash: "hash-antigo",
    empresa_id: empresaId,
  };
}

/** Uma campanha completa o bastante para `paraCampanha` nao quebrar. */
function campanha(id: string, empresaId: string, nome: string): Registro {
  return {
    id,
    nome,
    status: "em_andamento",
    lista_id: null,
    sequencia: [],
    intervalo_contatos_min: 30,
    intervalo_contatos_max: 60,
    intervalo_mensagens_min: 3,
    intervalo_mensagens_max: 8,
    validar_numeros: false,
    agendada_para: null,
    criada_em: "2026-01-01T00:00:00.000Z",
    iniciada_em: null,
    concluida_em: null,
    template_principal: null,
    pausada_motivo: null,
    rodada: 1,
    total_contatos: 0,
    total_enviadas: 0,
    total_entregues: 0,
    total_lidas: 0,
    total_falhas: 0,
    total_respostas: 0,
    empresa_id: empresaId,
  };
}

function bancoNovo(): Banco {
  return {
    campanhas: [
      campanha("campanha-a", EMPRESA_A, "campanha-da-a"),
      campanha("campanha-b", EMPRESA_B, "campanha-da-b"),
    ],
    canais: [canal("canal-a", EMPRESA_A, "canal-da-a"), canal("canal-b", EMPRESA_B, "canal-da-b")],
    perfis: [
      perfil("admin-a", EMPRESA_A, "admin"),
      perfil("operador-a", EMPRESA_A, "operator"),
      perfil("admin-b", EMPRESA_B, "admin"),
      perfil("operador-b", EMPRESA_B, "operator"),
      perfil("global", null, "admin"),
    ],
    canal_membros: [
      { canal_id: "canal-a", perfil_id: "admin-a", permissao: "owner" },
      { canal_id: "canal-a", perfil_id: "operador-a", permissao: "operator" },
      { canal_id: "canal-b", perfil_id: "admin-b", permissao: "owner" },
    ],
    campanha_canais: [],
    logs_auditoria: [],
  };
}

type Operacao =
  | { tipo: "select"; colunas: string; contagem: boolean }
  | { tipo: "update"; valores: Registro }
  | { tipo: "delete" }
  | { tipo: "insert"; valores: Registro }
  | { tipo: "upsert"; valores: Registro };

/**
 * Builder encadeável, thenable, no formato do supabase-js.
 *
 * `then` é o que permite `await consulta` sem `.maybeSingle()` — é assim que
 * `exigirOutroAdminAtivo` lê o `count`.
 */
class ConsultaFalsa implements PromiseLike<{ data: unknown; error: null; count: number }> {
  private readonly iguais: [string, unknown][] = [];
  private readonly diferentes: [string, unknown][] = [];
  private operacao: Operacao = { tipo: "select", colunas: "*", contagem: false };

  constructor(
    private readonly banco: Banco,
    private readonly tabela: keyof Banco,
  ) {}

  select(colunas = "*", opcoes?: { count?: string; head?: boolean }): this {
    // `select` depois de update/insert é a cláusula RETURNING, não uma
    // operação nova — só a primeira define o que a consulta faz.
    if (this.operacao.tipo === "select") {
      this.operacao = { tipo: "select", colunas, contagem: opcoes?.count === "exact" };
    }
    return this;
  }

  update(valores: Registro): this {
    this.operacao = { tipo: "update", valores };
    return this;
  }

  delete(): this {
    this.operacao = { tipo: "delete" };
    return this;
  }

  insert(valores: Registro): this {
    this.operacao = { tipo: "insert", valores };
    return this;
  }

  upsert(valores: Registro, _opcoes?: unknown): this {
    this.operacao = { tipo: "upsert", valores };
    return this;
  }

  eq(coluna: string, valor: unknown): this {
    this.iguais.push([coluna, valor]);
    return this;
  }

  is(coluna: string, valor: unknown): this {
    this.iguais.push([coluna, valor]);
    return this;
  }

  neq(coluna: string, valor: unknown): this {
    this.diferentes.push([coluna, valor]);
    return this;
  }

  order(): this {
    return this;
  }

  limit(): this {
    return this;
  }

  private casam(): Registro[] {
    return this.banco[this.tabela].filter(
      (linha) =>
        this.iguais.every(([coluna, valor]) => linha[coluna] === valor) &&
        this.diferentes.every(([coluna, valor]) => linha[coluna] !== valor),
    );
  }

  /**
   * Projeta o join `canais(...)` de `canal_membros`.
   *
   * É a única forma aninhada que os caminhos sob teste usam, e é justamente a
   * que escondia o vazamento: o vínculo liga perfil a canal e não menciona
   * empresa nenhuma.
   */
  private projetar(linhas: Registro[], colunas: string): Registro[] {
    if (this.tabela !== "canal_membros" || !colunas.includes("canais(")) return linhas;
    return linhas.map((membro) => ({
      canais: this.banco.canais.find((c) => c.id === membro.canal_id) ?? null,
    }));
  }

  private executar(): { data: Registro[]; count: number } {
    const casadas = this.casam();

    if (this.operacao.tipo === "select") {
      return { data: this.projetar(casadas, this.operacao.colunas), count: casadas.length };
    }
    if (this.operacao.tipo === "update") {
      for (const linha of casadas) Object.assign(linha, this.operacao.valores);
      return { data: casadas, count: casadas.length };
    }
    if (this.operacao.tipo === "delete") {
      // Remove de verdade: é o que permite ao teste provar que a linha da OUTRA
      // empresa continuou no banco depois de um delete que devia ter sido
      // barrado. Contar as barradas não bastaria — um filtro que não casa nada
      // e um delete que apaga tudo dão o mesmo `count`.
      this.banco[this.tabela] = this.banco[this.tabela].filter((l) => !casadas.includes(l));
      return { data: casadas, count: casadas.length };
    }
    // insert e upsert: o suficiente para a auditoria não estourar.
    const nova = { ...this.operacao.valores };
    this.banco[this.tabela].push(nova);
    return { data: [nova], count: 1 };
  }

  async maybeSingle(): Promise<{ data: Registro | null; error: null }> {
    return { data: this.executar().data[0] ?? null, error: null };
  }

  async single(): Promise<{ data: Registro | null; error: null }> {
    return this.maybeSingle();
  }

  then<R1 = { data: unknown; error: null; count: number }, R2 = never>(
    aoResolver?: ((v: { data: unknown; error: null; count: number }) => R1 | PromiseLike<R1>) | null,
    aoRejeitar?: ((r: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    const { data, count } = this.executar();
    return Promise.resolve({ data, error: null as null, count }).then(aoResolver, aoRejeitar);
  }
}

function supabaseFalso(banco: Banco): SupabaseService {
  return {
    tabela: (nome: string) => new ConsultaFalsa(banco, nome as keyof Banco),
    db: { rpc: async () => ({ data: null, error: null }) },
  } as unknown as SupabaseService;
}

/** Auditoria de verdade grava e derivaria empresa; aqui só não pode atrapalhar. */
const auditoriaFalsa = { registrar: async () => undefined } as unknown as AuditoriaService;

/**
 * Limites que nunca barram.
 *
 * O assunto aqui é ISOLAMENTO, não capacidade: um teto disparando no meio
 * destes testes faria um `ConflictException` passar por "acesso negado" e
 * esconderia exatamente o que eles existem para provar. Os limites têm suíte
 * própria em `limites.test.ts`.
 */
const limitesFalsos = {
  exigirEspacoParaCanal: async () => undefined,
  exigirEspacoParaCampanha: async () => undefined,
} as unknown as LimitesService;

function usuario(
  id: string,
  empresaId: string | null,
  papel: "admin" | "operator",
): UsuarioAutenticado {
  return { id, email: `${id}@exemplo.com`, nome: id, papel, empresaId, personificadoPor: null };
}

const ADMIN_A = usuario("admin-a", EMPRESA_A, "admin");
const OPERADOR_A = usuario("operador-a", EMPRESA_A, "operator");
const ADMIN_B = usuario("admin-b", EMPRESA_B, "admin");
const GLOBAL = usuario("global", null, "admin");

describe("isolamento entre empresas — canais", () => {
  let banco: Banco;
  let canais: CanaisService;

  beforeEach(() => {
    banco = bancoNovo();
    canais = new CanaisService(
      supabaseFalso(banco),
      auditoriaFalsa,
      {} as unknown as WhatsappService,
      limitesFalsos,
    );
  });

  it("admin de uma empresa não alcança canal de outra", async () => {
    // `papel === "admin"` não diz nada sobre empresa: cada cliente tem o
    // próprio admin. Antes da correção o early-return de admin vinha primeiro
    // e liberava qualquer canal do sistema.
    await expect(canais.exigirAcesso(ADMIN_A, "canal-b")).rejects.toThrow(ForbiddenException);
  });

  it("admin alcança canal da própria empresa", async () => {
    await expect(canais.exigirAcesso(ADMIN_A, "canal-a")).resolves.toBeUndefined();
  });

  it("a conta global atravessa as empresas, que é o acesso de suporte", async () => {
    await expect(canais.exigirAcesso(GLOBAL, "canal-a")).resolves.toBeUndefined();
    await expect(canais.exigirAcesso(GLOBAL, "canal-b")).resolves.toBeUndefined();
  });

  it("operador com vínculo plantado em canal de outra empresa continua barrado", async () => {
    // O vínculo cruzado é o cenário que sobra de um `definirMembro` antigo ou
    // de um perfil que mudou de empresa: `canal_membros` sozinho não prova
    // nada sobre empresa.
    banco.canal_membros.push({
      canal_id: "canal-b",
      perfil_id: "operador-a",
      permissao: "operator",
    });
    await expect(canais.exigirAcesso(OPERADOR_A, "canal-b")).rejects.toThrow(ForbiddenException);
  });

  it("a listagem do operador não mostra canal de outra empresa nem com vínculo", async () => {
    banco.canal_membros.push({
      canal_id: "canal-b",
      perfil_id: "operador-a",
      permissao: "operator",
    });
    const lista = await canais.listar(OPERADOR_A);
    expect(lista.map((c) => c.id)).toEqual(["canal-a"]);
  });

  /*
   * Excluir canal deixou de ser `@SomenteAdmin()` — operador conecta o próprio
   * número e precisa poder desconectá-lo. O que substituiu o guard é
   * `exigirDono`, e é ele que estes dois cobrem: sem essa trava, "operador cria
   * o próprio canal" viraria "operador exclui o canal do colega com quem ele
   * compartilha um número", e excluir apaga a instância na Evolution sem volta.
   */
  it("operador com acesso, mas sem ser dono, não exclui o canal", async () => {
    // `operador-a` é membro de `canal-a` com permissão "operator", não "owner".
    await expect(canais.excluir(OPERADOR_A, "canal-a", "127.0.0.1")).rejects.toThrow(
      /Só quem conectou/,
    );

    expect(banco.canais.some((c) => c.id === "canal-a")).toBe(true);
  });

  it("o dono passa pela trava e o canal sai da tabela", async () => {
    // O vínculo de "operator" é trocado por "owner": o dublê não tem
    // `maybeSingle` com ordenação, e dois vínculos para o mesmo par tornariam o
    // resultado dependente da ordem de inserção.
    banco.canal_membros = banco.canal_membros.filter((m) => m.perfil_id !== "operador-a");
    banco.canal_membros.push({ canal_id: "canal-a", perfil_id: "operador-a", permissao: "owner" });

    /*
     * A exclusão continua depois desta camada — chama a Evolution e limpa o
     * cache de agenda —, e nada disso está dublado aqui. O que este teste
     * afere é o que mudou: a trava de dono deixou o operador passar, e o
     * DELETE em `canais` chegou a acontecer.
     */
    const erro = await canais.excluir(OPERADOR_A, "canal-a", "127.0.0.1").catch((e: unknown) => e);

    expect(String(erro)).not.toMatch(/Só quem conectou/);
    expect(banco.canais.some((c) => c.id === "canal-a")).toBe(false);
  });

  it("a listagem do admin traz só os canais da empresa dele", async () => {
    expect((await canais.listar(ADMIN_A)).map((c) => c.id)).toEqual(["canal-a"]);
    expect((await canais.listar(ADMIN_B)).map((c) => c.id)).toEqual(["canal-b"]);
  });

  it("a listagem da conta global traz os canais de todas as empresas", async () => {
    expect((await canais.listar(GLOBAL)).map((c) => c.id).sort()).toEqual(["canal-a", "canal-b"]);
  });

  it("não dá para vincular ao próprio canal um perfil de outra empresa", async () => {
    // Sem esta guarda, bastava o uuid: quem opera a empresa B ganhava acesso
    // ao número da A, com agenda e campanhas junto.
    await expect(
      canais.definirMembro(ADMIN_A, "canal-a", "operador-b", "operator"),
    ).rejects.toThrow(ForbiddenException);

    expect(banco.canal_membros.some((m) => m.perfil_id === "operador-b")).toBe(false);
  });

  it("vincular alguém da própria empresa continua funcionando", async () => {
    banco.canal_membros = banco.canal_membros.filter((m) => m.perfil_id !== "operador-a");
    await canais.definirMembro(ADMIN_A, "canal-a", "operador-a", "operator");

    expect(
      banco.canal_membros.some((m) => m.canal_id === "canal-a" && m.perfil_id === "operador-a"),
    ).toBe(true);
  });

  it("não dá para mexer nos membros de um canal de outra empresa", async () => {
    await expect(
      canais.definirMembro(ADMIN_A, "canal-b", "operador-b", "operator"),
    ).rejects.toThrow(ForbiddenException);
    await expect(canais.listarMembros(ADMIN_A, "canal-b")).rejects.toThrow(ForbiddenException);
    await expect(canais.removerMembro(ADMIN_A, "canal-b", "admin-b")).rejects.toThrow(
      ForbiddenException,
    );
  });
});

describe("isolamento entre empresas — usuários", () => {
  let banco: Banco;
  let usuarios: UsuariosService;

  beforeEach(() => {
    banco = bancoNovo();
    usuarios = new UsuariosService(supabaseFalso(banco), auditoriaFalsa);
  });

  it("admin de uma empresa não redefine a senha de usuário de outra", async () => {
    // Era tomada de conta entre clientes: `PATCH /usuarios/:id` passa por
    // `@SomenteAdmin()`, e o admin de CADA empresa passa nesse guard.
    await expect(
      usuarios.ajustar(ADMIN_A, "operador-b", { senha: "senha-nova-123" }, "127.0.0.1"),
    ).rejects.toThrow(NotFoundException);

    const alvo = banco.perfis.find((p) => p.id === "operador-b");
    expect(alvo?.senha_hash).toBe("hash-antigo");
  });

  it("admin de uma empresa não desativa usuário de outra", async () => {
    await expect(
      usuarios.ajustar(ADMIN_A, "operador-b", { ativo: false }, "127.0.0.1"),
    ).rejects.toThrow(NotFoundException);

    expect(banco.perfis.find((p) => p.id === "operador-b")?.ativo).toBe(true);
  });

  it("admin ajusta usuário da própria empresa", async () => {
    await usuarios.ajustar(ADMIN_A, "operador-a", { ativo: false }, "127.0.0.1");
    expect(banco.perfis.find((p) => p.id === "operador-a")?.ativo).toBe(false);
  });

  it("a listagem de cada admin traz só a própria gente", async () => {
    expect((await usuarios.listar(ADMIN_A)).map((u) => u.id).sort()).toEqual([
      "admin-a",
      "operador-a",
    ]);
    expect((await usuarios.listar(ADMIN_B)).map((u) => u.id).sort()).toEqual([
      "admin-b",
      "operador-b",
    ]);
  });

  it("uma empresa não fica sem administrador porque outra tem um", async () => {
    /*
     * A contagem era global: bastava existir admin em QUALQUER empresa — e a
     * conta de administração do sistema sempre existe — para a guarda liberar
     * desativar o último admin de uma empresa. O cliente ficava sem ninguém
     * que pudesse criar acesso ou conectar canal, sem volta pelo produto.
     *
     * O autor aqui é a conta global de propósito: com `ADMIN_B` desativando a
     * si mesmo, quem barraria seria a guarda do "próprio acesso", que é outra
     * regra — e o teste passaria mesmo com a contagem errada.
     */
    await expect(
      usuarios.ajustar(GLOBAL, "admin-b", { ativo: false }, "127.0.0.1"),
    ).rejects.toThrow(/último administrador/);

    expect(banco.perfis.find((p) => p.id === "admin-b")?.ativo).toBe(true);
  });

  it("desativar o próprio acesso de admin continua barrado", async () => {
    await expect(
      usuarios.ajustar(ADMIN_A, "admin-a", { ativo: false }, "127.0.0.1"),
    ).rejects.toThrow(/próprio acesso/);

    expect(banco.perfis.find((p) => p.id === "admin-a")?.ativo).toBe(true);
  });

  it("com dois admins na empresa, rebaixar um é permitido", async () => {
    banco.perfis.push(perfil("admin-a2", EMPRESA_A, "admin"));
    await usuarios.ajustar(ADMIN_A, "admin-a2", { papel: "operator" }, "127.0.0.1");
    expect(banco.perfis.find((p) => p.id === "admin-a2")?.papel).toBe("operator");
  });

  /*
   * Os três abaixo cobrem a CRIAÇÃO, que era o buraco.
   *
   * O resto deste arquivo prova que ninguém LÊ dentro da empresa vizinha. Não
   * provava nada sobre de quem é o acesso que acabou de nascer — e foi por ali
   * que vazou: a tela de Usuários chamava `criar` sem `empresaId`, o `??` de
   * antes transformava o campo ausente em `null`, e `null` é acesso GLOBAL.
   * O cliente entrava e via canal, campanha e dashboard de todas as empresas,
   * sem nada falhar em lugar nenhum.
   */

  it("admin de empresa não cria acesso nenhum, nem na própria empresa", async () => {
    await expect(
      usuarios.criar(
        ADMIN_A,
        {
          nome: "Novo",
          email: "novo@exemplo.com",
          senha: "Trovao-Marulho-92",
          papel: "operator",
          empresaId: EMPRESA_A,
        },
        "127.0.0.1",
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(banco.perfis.some((p) => p.email === "novo@exemplo.com")).toBe(false);
  });

  it("a conta global sem empresa no corpo é recusada, em vez de criar outro acesso global", async () => {
    await expect(
      usuarios.criar(
        GLOBAL,
        {
          nome: "Roberto",
          email: "roberto@acesso.com",
          senha: "Trovao-Marulho-92",
          papel: "admin",
        },
        "127.0.0.1",
      ),
    ).rejects.toThrow(/Informe a empresa/);

    expect(banco.perfis.some((p) => p.email === "roberto@acesso.com")).toBe(false);
  });

  it("admin de empresa não exclui ninguém, nem da própria empresa", async () => {
    await expect(usuarios.excluir(ADMIN_A, "operador-a", "127.0.0.1")).rejects.toThrow(
      ForbiddenException,
    );

    expect(banco.perfis.some((p) => p.id === "operador-a")).toBe(true);
  });

  it("a conta global exclui, e o perfil some da tabela", async () => {
    await usuarios.excluir(GLOBAL, "operador-a", "127.0.0.1");
    expect(banco.perfis.some((p) => p.id === "operador-a")).toBe(false);
  });

  it("excluir o próprio acesso é barrado", async () => {
    await expect(usuarios.excluir(GLOBAL, "global", "127.0.0.1")).rejects.toThrow(/próprio acesso/);
    expect(banco.perfis.some((p) => p.id === "global")).toBe(true);
  });

  it("excluir o último admin de uma empresa é barrado", async () => {
    // `admin-a` é o único administrador da empresa A: sem ele, ninguém dela
    // consegue mais gerenciar canais nem acessos, e exclusão não tem desfazer.
    await expect(usuarios.excluir(GLOBAL, "admin-a", "127.0.0.1")).rejects.toThrow(
      /último administrador/,
    );
    expect(banco.perfis.some((p) => p.id === "admin-a")).toBe(true);
  });

  it("com dois admins na empresa, excluir um é permitido", async () => {
    banco.perfis.push(perfil("admin-a2", EMPRESA_A, "admin"));
    await usuarios.excluir(GLOBAL, "admin-a2", "127.0.0.1");
    expect(banco.perfis.some((p) => p.id === "admin-a2")).toBe(false);
  });

  it("`empresaId: null` ESCRITO continua criando administrador de sistema", async () => {
    await usuarios.criar(
      GLOBAL,
      {
        nome: "Suporte",
        email: "suporte@exemplo.com",
        senha: "Trovao-Marulho-92",
        papel: "admin",
        empresaId: null,
      },
      "127.0.0.1",
    );

    const criado = banco.perfis.find((p) => p.email === "suporte@exemplo.com");
    expect(criado?.empresa_id).toBeNull();
  });
});

/**
 * Campanhas: o serviço com mais superfície de escopo do repositório — nove
 * chamadas a `noEscopo` e sete a `empresaParaEscrita` — e o que estava de fora
 * destes testes.
 *
 * O padrão aqui é diferente do de canais: `pausar`, `retomar`, `editar` e
 * `excluir` não repetem o filtro de empresa nas escritas. Eles chamam `obter`
 * primeiro, e é `obter` que carrega o `noEscopo`. Funciona, e é justamente o
 * arranjo que o comentário no topo deste arquivo descreve: o que falha não é a
 * função de escopo, é o caminho que se esquece de chamá-la. Um `pausar` que um
 * dia deixe de começar por `obter` passa a pausar campanha de qualquer cliente
 * — e nada na tela do dono muda.
 *
 * Por isso cada caminho de escrita é exercitado contra a campanha da OUTRA
 * empresa, e não só o `obter`.
 */
describe("isolamento entre empresas — campanhas", () => {
  let banco: Banco;
  let campanhas: CampanhasService;

  beforeEach(() => {
    banco = bancoNovo();
    campanhas = new CampanhasService(
      supabaseFalso(banco),
      auditoriaFalsa,
      { exigirAcesso: async () => undefined } as unknown as CanaisService,
      { publicar: async () => undefined } as unknown as FilaService,
      limitesFalsos,
    );
  });

  it("admin de uma empresa não lê campanha de outra", async () => {
    await expect(campanhas.obter(ADMIN_A, "campanha-b")).rejects.toThrow(NotFoundException);
  });

  it("admin lê a campanha da própria empresa", async () => {
    await expect(campanhas.obter(ADMIN_A, "campanha-a")).resolves.toMatchObject({
      id: "campanha-a",
    });
  });

  it("a conta global atravessa as empresas, que é o acesso de suporte", async () => {
    await expect(campanhas.obter(GLOBAL, "campanha-a")).resolves.toMatchObject({
      id: "campanha-a",
    });
    await expect(campanhas.obter(GLOBAL, "campanha-b")).resolves.toMatchObject({
      id: "campanha-b",
    });
  });

  it("operador não pausa campanha de outra empresa", async () => {
    await expect(campanhas.pausar(OPERADOR_A, "campanha-b", "1.2.3.4")).rejects.toThrow(
      NotFoundException,
    );

    // A campanha da outra empresa continua como estava: a recusa tem de vir
    // ANTES da escrita, não depois de já ter mudado o status.
    const alvo = banco.campanhas.find((c) => c.id === "campanha-b");
    expect(alvo?.status).toBe("em_andamento");
  });

  it("admin não exclui campanha de outra empresa, e a linha sobrevive", async () => {
    await expect(campanhas.excluir(ADMIN_A, "campanha-b", "1.2.3.4")).rejects.toThrow(
      NotFoundException,
    );
    expect(banco.campanhas.some((c) => c.id === "campanha-b")).toBe(true);
  });

  it("admin exclui a da própria empresa — a recusa acima é de escopo, não de papel", async () => {
    // Sem este par, o teste anterior passaria mesmo se `excluir` estivesse
    // quebrado para todo mundo.
    await expect(campanhas.excluir(ADMIN_A, "campanha-a", "1.2.3.4")).resolves.toBe("campanha-a");
    expect(banco.campanhas.some((c) => c.id === "campanha-a")).toBe(false);
  });
});
