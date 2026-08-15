import { Injectable } from "@nestjs/common";
import type {
  Canal,
  MensagemSequencia,
  MetodoPareamento,
  ProvedorWhatsApp,
  ResultadoEnvio,
  Spintax,
  Template,
} from "@disparoy/dominio";
import { indexarVariacoes, renderizarMensagem } from "@disparoy/dominio";
import { metaConfigurada, provedorMetaCloud } from "./meta-cloud";
import { evolutionConfigurada, provedorEvolution } from "./evolution-provider";

export interface EstadoIntegracao {
  evolutionConfigurada: boolean;
  metaConfigurada: boolean;
  /** Nenhum provedor configurado: todo disparo vai falhar. */
  semProvedor: boolean;
}

export interface ResultadoPasso {
  passo: number;
  mensagemId: string;
  corpoRenderizado: string;
  resultado: ResultadoEnvio;
}

/** Contato reduzido ao que o envio precisa saber. */
export interface DestinatarioEnvio {
  telefone: string;
  variaveis: Record<string, string>;
}

@Injectable()
export class WhatsappService {
  /** Escolhe o provedor pelo tipo de conexão do canal. */
  provedorPara(canal: Canal): ProvedorWhatsApp {
    return canal.tipoConexao === "api_oficial" ? provedorMetaCloud : provedorEvolution;
  }

  estadoIntegracao(): EstadoIntegracao {
    const evolution = evolutionConfigurada();
    const meta = metaConfigurada();
    return {
      evolutionConfigurada: evolution,
      metaConfigurada: meta,
      semProvedor: !evolution && !meta,
    };
  }

  listarTemplatesMeta(): Promise<Template[]> {
    return provedorMetaCloud.listarTemplates();
  }

  iniciarSessaoQr(canal: Canal, opcoes?: { metodo?: MetodoPareamento; numero?: string }) {
    return provedorEvolution.iniciarSessao(canal, opcoes);
  }

  async encerrarSessaoQr(canal: Canal): Promise<void> {
    await provedorEvolution.encerrarSessao(canal);
  }

  validarNumeros(canal: Canal, numeros: string[]) {
    return this.provedorPara(canal).validarNumeros(canal, numeros);
  }

  /**
   * Envia a sequência inteira para UM contato, resolvendo spintax e variáveis
   * a cada passo — é isso que faz dois contatos receberem textos diferentes.
   *
   * A espera entre passos é responsabilidade de quem chama (o worker), porque
   * só ele sabe o intervalo configurado na campanha.
   */
  async dispararSequencia(entrada: {
    canal: Canal;
    destinatario: DestinatarioEnvio;
    sequencia: MensagemSequencia[];
    variacoes: Spintax[];
    /**
     * Passos (1-based) que já foram entregues numa tentativa anterior.
     *
     * O job de contato tem retry. Sem esta lista, uma sequência que falha no
     * terceiro passo reenviaria os dois primeiros na nova tentativa — e receber
     * a mesma mensagem duas vezes é o tipo de coisa que faz o contato denunciar
     * o número, que é exatamente o que o sistema inteiro tenta evitar.
     */
    pularPassos?: ReadonlySet<number>;
    /** Chamado depois de cada passo, antes do próximo. */
    aoTerminarPasso?: (r: ResultadoPasso) => Promise<void>;
  }): Promise<ResultadoPasso[]> {
    const provedor = this.provedorPara(entrada.canal);
    const variacoes = indexarVariacoes(entrada.variacoes);
    const saida: ResultadoPasso[] = [];

    for (const [indice, mensagem] of entrada.sequencia.entries()) {
      // O passo é 1-based porque é assim que ele é gravado em
      // `mensagens_enviadas` e mostrado na tela da campanha.
      if (entrada.pularPassos?.has(indice + 1)) continue;

      const corpoRenderizado = renderizarMensagem(mensagem.corpo, {
        variacoes,
        variaveis: entrada.destinatario.variaveis,
      });

      const resultado = await provedor.enviar({
        canal: entrada.canal,
        para: entrada.destinatario.telefone,
        mensagem,
        corpoRenderizado,
        parametrosTemplate: parametrosPosicionais(entrada.destinatario.variaveis),
      });

      const passo: ResultadoPasso = {
        passo: indice + 1,
        mensagemId: mensagem.id,
        corpoRenderizado,
        resultado,
      };
      saida.push(passo);
      await entrada.aoTerminarPasso?.(passo);

      // Uma falha interrompe o restante da sequência para aquele contato:
      // insistir depois de um bloqueio só aumenta o risco na conta.
      if (!resultado.ok) break;
    }

    return saida;
  }
}

/** Extrai {"1": "Ana", "2": "verão"} na ordem numérica para o corpo do template. */
function parametrosPosicionais(variaveis: Record<string, string>): string[] {
  return Object.keys(variaveis)
    .filter((k) => /^\d+$/.test(k))
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => variaveis[k]);
}
