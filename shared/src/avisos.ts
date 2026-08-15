import type { CategoriaFalha, CodigoFalha } from "./whatsapp/falhas.js";
import { FALHAS } from "./whatsapp/falhas.js";

/**
 * Como uma falha se apresenta para o operador.
 *
 * O selo de origem é o produto inteiro desta camada: ele nomeia de quem foi a
 * culpa ANTES de qualquer outra informação. É a diferença entre o cliente pegar
 * o celular para reconectar o QR e o cliente te ligar achando que o sistema
 * quebrou.
 *
 * Nada aqui é armazenado no banco — tudo é derivado de `categoria`. Assim,
 * mudar uma palavra não exige migration e não existem duas verdades sobre a
 * mesma linha.
 */

export type Severidade = "critico" | "atencao" | "informativo";

/** Mapeia direto nas variáveis de cor do painel. */
export type TomOrigem = "perigo" | "atencao" | "informacao" | "neutro";

export interface Origem {
  /** O selo. Escrito na língua do operador, não na do sistema. */
  rotulo: string;
  tom: TomOrigem;
  /** Primeira frase do corpo. Existe para dizer de quem NÃO é a culpa. */
  abertura: string;
}

export const ORIGENS: Record<CategoriaFalha, Origem> = {
  canal: {
    rotulo: "Seu WhatsApp",
    tom: "perigo",
    abertura: "O problema está no aparelho conectado, não no Disparoy.",
  },
  destinatario: {
    rotulo: "Números de destino",
    tom: "atencao",
    abertura: "Não é falha do sistema nem do seu número.",
  },
  infra: {
    rotulo: "Nosso servidor",
    tom: "informacao",
    abertura: "Não é problema do seu WhatsApp — ele continua conectado.",
  },
  configuracao: {
    rotulo: "Configuração",
    tom: "informacao",
    abertura: "Falta um ajuste na instalação; nada foi enviado errado.",
  },
  conteudo: {
    rotulo: "Sua mensagem",
    tom: "atencao",
    abertura: "O WhatsApp recusou o conteúdo desta campanha.",
  },
  limite: {
    rotulo: "Limite do canal",
    tom: "neutro",
    abertura: "Não é erro: é a proteção contra bloqueio funcionando.",
  },
};

export function origemDe(categoria: CategoriaFalha): Origem {
  return ORIGENS[categoria];
}

/**
 * Severidade derivada do perfil da falha, nunca digitada.
 *
 * É consequência de o disparo ter parado ou não. Deixá-la solta abriria espaço
 * para um aviso "informativo" que na verdade parou a campanha inteira.
 */
export function severidadeDe(codigo: CodigoFalha): Severidade {
  const perfil = FALHAS[codigo];
  if (perfil.paraCampanha) return "critico";
  if (perfil.categoria === "destinatario" || perfil.categoria === "limite") return "informativo";
  return "atencao";
}

export interface Aviso {
  id: number;
  incidenteId: number | null;
  tipo: "abertura" | "resolucao";
  categoria: CategoriaFalha;
  codigo: string;
  titulo: string;
  corpo: string;
  canalId: string | null;
  canalNome: string | null;
  campanhaId: string | null;
  criadaEm: string;
  lidaEm: string | null;
}

export interface Incidente {
  id: number;
  categoria: CategoriaFalha;
  codigo: string;
  canalId: string | null;
  canalNome: string | null;
  campanhaId: string | null;
  titulo: string;
  detalhe: string | null;
  ocorrencias: number;
  abertoEm: string;
  resolvidoEm: string | null;
}
