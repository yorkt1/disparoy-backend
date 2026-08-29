import { describe, expect, it } from "vitest";
import {
  detectarColunaNome,
  detectarColunaTelefone,
  ehPedidoDeSaida,
  mapeamentoPadrao,
  montarContatos,
  montarContatosColados,
} from "../src/contatos";
import { renderizarMensagem } from "../src/spintax";

describe("detectarColunaTelefone", () => {
  it("reconhece nomes usuais de coluna", () => {
    expect(detectarColunaTelefone(["nome", "telefone", "cidade"])).toBe("telefone");
    expect(detectarColunaTelefone(["Nome", "Celular", "UF"])).toBe("Celular");
    expect(detectarColunaTelefone(["nome", "WhatsApp"])).toBe("WhatsApp");
  });

  it("reconhece variações com acento e separador", () => {
    expect(detectarColunaTelefone(["Nome", "Número"])).toBe("Número");
    expect(detectarColunaTelefone(["nome", "num_telefone"])).toBe("num_telefone");
  });

  it("cai na primeira coluna quando nada é reconhecido", () => {
    expect(detectarColunaTelefone(["coluna_a", "coluna_b"])).toBe("coluna_a");
  });

  it("devolve string vazia sem colunas", () => {
    expect(detectarColunaTelefone([])).toBe("");
  });
});

describe("detectarColunaNome", () => {
  it("acha a coluna de nome ignorando a do telefone", () => {
    expect(detectarColunaNome(["telefone", "nome", "cidade"], "telefone")).toBe("nome");
    expect(detectarColunaNome(["Celular", "Cliente"], "Celular")).toBe("Cliente");
  });

  it("devolve vazio quando não há candidata clara", () => {
    expect(detectarColunaNome(["telefone", "cidade", "uf"], "telefone")).toBe("");
  });

  it("não devolve a própria coluna de telefone", () => {
    // "contato" está nas duas listas de sinônimos; se já é o telefone, não pode
    // ser escolhido também como nome.
    expect(detectarColunaNome(["contato", "cidade"], "contato")).toBe("");
  });
});

describe("montarContatos", () => {
  const linhas = [
    { numero: "11987654321", nome: "Marina", cidade: "São Paulo" },
    { numero: "(11) 98765-4321", nome: "Marina duplicada", cidade: "São Paulo" },
    { numero: "21998877665", nome: "Rafael", cidade: "Rio" },
    { numero: "abc", nome: "Inválido", cidade: "BH" },
  ];

  it("normaliza, deduplica e marca inválidos", () => {
    const r = montarContatos(linhas, "numero");
    expect(r.validos).toBe(2);
    expect(r.duplicados).toBe(1);
    expect(r.invalidos).toBe(1);
    expect(r.contatos).toHaveLength(3); // duplicata sai, inválido fica para revisão
  });

  it("preserva o número original e o motivo do inválido", () => {
    const invalido = montarContatos(linhas, "numero").contatos.find((c) => !c.valido);
    expect(invalido?.telefoneOriginal).toBe("abc");
    expect(invalido?.motivoInvalido).toBe("Formato não reconhecido");
  });

  it("extrai o nome da coluna indicada", () => {
    const r = montarContatos(linhas, "numero", { colunaNome: "nome" });
    expect(r.contatos[0].nome).toBe("Marina");
  });

  it("deixa o nome nulo quando a coluna não é informada", () => {
    expect(montarContatos(linhas, "numero").contatos[0].nome).toBeNull();
  });

  it("mapeia colunas extras para variáveis do template", () => {
    const r = montarContatos(linhas, "numero", {
      mapeamento: { "1": "nome", "2": "cidade" },
    });
    expect(r.contatos[0].variaveis).toEqual({ "1": "Marina", "2": "São Paulo" });
  });

  it("ignora mapeamento apontando para coluna vazia ou inexistente", () => {
    const r = montarContatos(linhas, "numero", {
      mapeamento: { "1": "", "2": "inexistente" },
    });
    expect(r.contatos[0].variaveis).toEqual({});
  });

  it("trata a lista vazia sem quebrar", () => {
    expect(montarContatos([], "numero")).toEqual({
      contatos: [],
      validos: 0,
      invalidos: 0,
      duplicados: 0,
    });
  });
});

describe("montarContatosColados", () => {
  it("aceita números separados por linha e vírgula", () => {
    const r = montarContatosColados("11987654321\n21998877665, 31988112244");
    expect(r.validos).toBe(3);
    expect(r.contatos.every((c) => c.valido)).toBe(true);
  });

  it("deduplica a colagem", () => {
    const r = montarContatosColados("11987654321\n+55 11 98765-4321");
    expect(r.validos).toBe(1);
    expect(r.duplicados).toBe(1);
  });
});

describe("ehPedidoDeSaida", () => {
  it("reconhece as palavras-chave isoladas", () => {
    for (const t of ["PARAR", "sair", "Stop", "cancelar", "  remover  "]) {
      expect(ehPedidoDeSaida(t)).toBe(true);
    }
  });

  it("ignora acento e pontuação", () => {
    expect(ehPedidoDeSaida("não quero!")).toBe(true);
    expect(ehPedidoDeSaida("Não perturbe.")).toBe(true);
  });

  it("aceita pedido curto com a palavra no meio", () => {
    expect(ehPedidoDeSaida("quero sair da lista")).toBe(true);
  });

  it("não descadastra por palavra solta em frase longa", () => {
    // O caso que mais dói: elogio virando opt-out.
    expect(
      ehPedidoDeSaida("não vou parar de recomendar vocês para todos os meus amigos"),
    ).toBe(false);
  });

  it("ignora mensagens normais", () => {
    expect(ehPedidoDeSaida("oi, tudo bem?")).toBe(false);
    expect(ehPedidoDeSaida("quero saber mais")).toBe(false);
    expect(ehPedidoDeSaida("")).toBe(false);
  });
});

describe("mapeamentoPadrao", () => {
  it("faz {{1}} valer o nome e as extras seguirem em {{2}}", () => {
    expect(mapeamentoPadrao(["nome", "telefone", "cidade"], "telefone", "nome")).toEqual({
      "1": "nome",
      nome: "nome",
      "2": "cidade",
      cidade: "cidade",
    });
  });

  it("sem coluna de nome, a primeira extra ocupa {{1}}", () => {
    // Senão `{{1}}` ficaria eternamente vazio numa planilha só de números e
    // colunas de negócio, e o operador não teria como referenciar a primeira.
    expect(mapeamentoPadrao(["telefone", "cupom"], "telefone", "")).toEqual({
      "1": "cupom",
      cupom: "cupom",
    });
  });

  it("dá nome acessível às colunas com acento e espaço", () => {
    expect(mapeamentoPadrao(["fone", "Data da Compra"], "fone", "")).toEqual({
      "1": "Data da Compra",
      data_da_compra: "Data da Compra",
    });
  });

  it("coluna chamada '2' não sequestra a posicional {{2}}", () => {
    const mapa = mapeamentoPadrao(["fone", "nome", "2", "cidade"], "fone", "nome");
    expect(mapa["2"]).toBe("2");
    expect(mapa["3"]).toBe("cidade");
  });
});

describe("montarContatos sem mapeamento explícito", () => {
  const linhas = [
    { Nome: "Maria", Telefone: "11988887777", Cidade: "Recife" },
    { Nome: "João", Telefone: "11977776666", Cidade: "Natal" },
  ];

  it("preenche as variáveis com o nome e as colunas extras", () => {
    const r = montarContatos(linhas, "Telefone", {
      colunaNome: "Nome",
      colunas: ["Nome", "Telefone", "Cidade"],
    });

    expect(r.contatos[0].variaveis).toEqual({
      "1": "Maria",
      nome: "Maria",
      "2": "Recife",
      cidade: "Recife",
    });
  });

  /*
   * O teste que faltava. "Olá {{1}}" saía com as chaves literais para a lista
   * inteira porque `variaveis` chegava vazio ao `renderizarMensagem` — e nada
   * quebrava, porque referência não resolvida é mantida de propósito.
   */
  it("faz 'Olá {{1}}' virar 'Olá Maria' no texto renderizado", () => {
    const r = montarContatos(linhas, "Telefone", {
      colunaNome: "Nome",
      colunas: ["Nome", "Telefone", "Cidade"],
    });

    const texto = renderizarMensagem("Olá {{1}}, tudo bem? Vi que você é de {{cidade}}.", {
      variacoes: {},
      variaveis: r.contatos[0].variaveis,
    });

    expect(texto).toBe("Olá Maria, tudo bem? Vi que você é de Recife.");
  });

  it("números colados continuam sem variável nenhuma", () => {
    // Não há coluna para mapear: `{{1}}` fica literal, que é o certo — melhor
    // o operador ver o buraco do que a mensagem sair com "Olá ,".
    const r = montarContatosColados("11988887777");
    expect(r.contatos[0].variaveis).toEqual({});
  });

  it("mapeamento explícito continua vencendo o padrão", () => {
    const r = montarContatos(linhas, "Telefone", {
      colunaNome: "Nome",
      colunas: ["Nome", "Telefone", "Cidade"],
      mapeamento: { "1": "Cidade" },
    });
    expect(r.contatos[0].variaveis).toEqual({ "1": "Recife" });
  });
});
