import { describe, expect, it } from "vitest";
import {
  chavesDeVariaveis,
  descreverConexao,
  descreverResposta,
  descreverStatus,
  escapar,
  formatarDataHoraCompleta,
  montarCsv,
  type LinhaRelatorio,
} from "./relatorio";

/**
 * O relatório é contrato com quem abre a planilha, não detalhe interno: o
 * cliente importa este arquivo em outra ferramenta e filtra por coluna. O que
 * estes testes guardam é a forma — cabeçalho, ordem, separador — e o
 * tratamento do único campo que ninguém controla, que é o texto escrito pelo
 * contato.
 */

function linha(parcial: Partial<LinhaRelatorio> = {}): LinhaRelatorio {
  return {
    envio: "2026-08-15T13:01:39.000Z",
    canalNome: "Antonio Carlos",
    canalNumero: "+554791169041",
    nome: "Jucileia",
    telefone: "+554799599483",
    lida: true,
    respostas: [],
    status: "concluido",
    motivo: null,
    variaveis: {},
    ...parcial,
  };
}

describe("montarCsv", () => {
  it("mantém o cabeçalho e a ordem das colunas", () => {
    const csv = montarCsv([], []);
    const [cabecalho] = csv.replace("\uFEFF", "").split("\r\n");

    expect(cabecalho).toBe(
      "envio;conexao;nome;whatsapp;lida;resposta_1;resposta_2;resposta_3;resposta_4;" +
        "resposta_5;status;variavel_1;variavel_2;variavel_3;variavel_4;variavel_5;" +
        "variavel_6;variavel_7",
    );
  });

  it("escreve a linha do contato no formato esperado", () => {
    const csv = montarCsv(
      [
        linha({
          respostas: [
            { texto: "Bom dia", tipo: "texto" },
            { texto: "Pode contar comigo sim", tipo: "texto" },
          ],
        }),
      ],
      [],
    );

    expect(csv.replace("\uFEFF", "").split("\r\n")[1]).toBe(
      "15/08/2026 10:01:39;Antonio Carlos [554791169041];Jucileia;554799599483;Lida;" +
        "Bom dia;Pode contar comigo sim;;;;Enviado com sucesso;;;;;;;",
    );
  });

  /*
   * O BOM não é enfeite: sem ele o Excel em português lê o arquivo como ANSI e
   * toda resposta com emoji — que numa campanha é a maioria — vira lixo na
   * tela de quem pediu o relatório.
   */
  it("começa com BOM para o Excel ler UTF-8", () => {
    expect(montarCsv([linha({ respostas: [{ texto: "🙌🏻", tipo: "texto" }] })], [])).toMatch(
      /^\uFEFF/,
    );
  });

  it("corta na quinta resposta", () => {
    const respostas = Array.from({ length: 8 }, (_, i) => ({
      texto: `r${i + 1}`,
      tipo: "texto" as const,
    }));
    const campos = montarCsv([linha({ respostas })], []).replace("\uFEFF", "").split("\r\n")[1]!;

    expect(campos.split(";").slice(5, 10)).toEqual(["r1", "r2", "r3", "r4", "r5"]);
  });

  it("põe cada variável na mesma coluna em todas as linhas", () => {
    const linhas = [
      linha({ variaveis: { cidade: "Joinville", plano: "Ouro" } }),
      // Sem `cidade`: a coluna dela precisa sair VAZIA, e não puxar o `plano`
      // uma casa para a esquerda.
      linha({ variaveis: { plano: "Prata" } }),
    ];
    const chaves = chavesDeVariaveis(linhas);
    const [, primeira, segunda] = montarCsv(linhas, chaves).replace("\uFEFF", "").split("\r\n");

    expect(chaves).toEqual(["cidade", "plano"]);
    expect(primeira!.split(";").slice(11, 13)).toEqual(["Joinville", "Ouro"]);
    expect(segunda!.split(";").slice(11, 13)).toEqual(["", "Prata"]);
  });
});

describe("escapar", () => {
  it("aspas o campo que contém o separador", () => {
    expect(escapar("sim; pode ligar")).toBe('"sim; pode ligar"');
  });

  it("dobra as aspas de dentro do texto", () => {
    expect(escapar('ele disse "não"')).toBe('"ele disse ""não"""');
  });

  /*
   * Uma resposta de três parágrafos não pode virar três registros: o arquivo é
   * lido por script e por olho humano, e os dois quebram com registro partido.
   */
  it("achata a quebra de linha em espaço", () => {
    expect(escapar("bom dia\nquero sim")).toBe("bom dia quero sim");
  });

  /*
   * Injeção de fórmula: o texto vem do CONTATO, e `=` no início de célula faz o
   * Excel executar em vez de exibir.
   */
  it("neutraliza texto que o Excel leria como fórmula", () => {
    expect(escapar("=1+1")).toBe("'=1+1");
    expect(escapar("@todos")).toBe("'@todos");
    expect(escapar("-5")).toBe("'-5");
  });

  it("não mexe em texto comum", () => {
    expect(escapar("Que benção sim")).toBe("Que benção sim");
  });
});

describe("descreverResposta", () => {
  /*
   * Célula vazia significa "não respondeu", e áudio é a resposta mais comum de
   * campanha em massa: sem rótulo, quem mandou três áudios ficaria idêntico a
   * quem ignorou a mensagem.
   */
  it("rotula mídia sem legenda", () => {
    expect(descreverResposta({ texto: "", tipo: "audio" })).toBe("[áudio]");
  });

  it("mantém a legenda junto do rótulo", () => {
    expect(descreverResposta({ texto: "pode me ligar", tipo: "imagem" })).toBe(
      "[imagem] pode me ligar",
    );
  });

  it("texto puro sai sem rótulo", () => {
    expect(descreverResposta({ texto: "Bom dia", tipo: "texto" })).toBe("Bom dia");
  });
});

describe("descreverStatus", () => {
  it("traduz o sucesso", () => {
    expect(descreverStatus("concluido", null)).toBe("Enviado com sucesso");
  });

  it("leva o motivo junto da falha", () => {
    expect(descreverStatus("falhou", "canal desconectado")).toBe("Falhou: canal desconectado");
  });

  it("falha sem motivo ainda diz que falhou", () => {
    expect(descreverStatus("falhou", null)).toBe("Falhou");
  });
});

describe("descreverConexao", () => {
  /*
   * Dois chips com o mesmo apelido é o caso comum ("Comercial 1", "Comercial
   * 2"), e a pergunta que se faz olhando a planilha depois de um bloqueio é
   * "qual NÚMERO mandou isto?".
   */
  it("acompanha o número do canal", () => {
    expect(descreverConexao("Antonio Carlos", "+554791169041")).toBe(
      "Antonio Carlos [554791169041]",
    );
  });

  it("diz o que aconteceu quando o canal sumiu", () => {
    expect(descreverConexao(null, null)).toBe("Canal removido");
  });
});

describe("formatarDataHoraCompleta", () => {
  /*
   * O `format` do pt-BR insere vírgula entre data e hora, e a vírgula é
   * inofensiva neste CSV (o separador é `;`) mas não é o formato que a
   * planilha do cliente espera.
   */
  it("usa o fuso de quem operou o disparo, sem vírgula", () => {
    expect(formatarDataHoraCompleta("2026-08-15T13:01:39.000Z")).toBe("15/08/2026 10:01:39");
  });

  it("contato ainda não processado sai com a coluna vazia", () => {
    expect(formatarDataHoraCompleta(null)).toBe("");
  });
});
