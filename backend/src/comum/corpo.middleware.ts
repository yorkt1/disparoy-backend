import type { NextFunction, Request, Response } from "express";
import { LIMITES } from "@disparoy/dominio";

/**
 * Teto de corpo por rota.
 *
 * O `bodyParser: true` do Nest não passa `limit` nenhum, então valia o padrão
 * do Express: **100 kB para JSON**. Isso não era só frouxo, era estreito demais
 * no lugar errado — `POST /api/campanhas` recebe o público inteiro num único
 * JSON (`campanhaEntradaSchema.publico`, até 20 mil contatos), e qualquer
 * campanha acima de ~1.500 contatos era recusada pelo body-parser antes de
 * chegar no Nest. O erro nasce no middleware do Express, longe do
 * `FiltroExcecoes`, então o painel via falha de rede sem mensagem.
 *
 * O parser tem um limite só, global. Se ele for grande o bastante para a
 * campanha, passa a valer também para `POST /api/webhooks/evolution`, que é
 * público: qualquer um na internet faria a API bufferizar megabytes por
 * requisição, dentro do teto de 400 requisições/10 s que aquela rota tem de
 * propósito. Por isso o parser vai no maior valor legítimo e este middleware
 * recorta o teto de cada rota antes dele.
 */

const KB = 1024;
const MB = 1024 * KB;

/**
 * Suficiente para tudo que não é upload nem público de campanha: o maior corpo
 * previsto entre elas é uma sequência de 10 mensagens de 4.096 caracteres.
 */
export const TETO_PADRAO = 128 * KB;

/**
 * Derivado do schema, não escolhido a olho: `maxContatosPorImportacao` contatos
 * de ~400 bytes cada (telefone, nome de até 120 caracteres e as variáveis
 * vindas das colunas da planilha), com folga. Uma campanha no extremo absoluto
 * — 20 mil contatos com muitas variáveis longas — ainda esbarra aqui, e recebe
 * um 413 explicando o que fazer em vez de uma falha de rede.
 */
export const TETO_CAMPANHA = 8 * MB;

/**
 * Os eventos da Evolution têm poucos kB; o maior é o `QRCODE_UPDATED`, com o PNG
 * do QR em base64. Meio megabyte é ordens de grandeza acima do que ela manda e
 * dezesseis vezes abaixo do teto do parser — que é o ponto, já que esta é a
 * única rota que um desconhecido alcança.
 */
export const TETO_WEBHOOK = 512 * KB;

interface TetoDeRota {
  metodo: string;
  caminho: string;
  bytes: number;
}

const TETOS: readonly TetoDeRota[] = [
  { metodo: "POST", caminho: "/api/campanhas", bytes: TETO_CAMPANHA },
  { metodo: "POST", caminho: "/api/webhooks/evolution", bytes: TETO_WEBHOOK },
];

/** Métodos sem corpo. `DELETE` entra: nenhuma rota daqui manda corpo nele. */
const SEM_CORPO = new Set(["GET", "HEAD", "OPTIONS", "DELETE"]);

/**
 * Recusa o corpo grande demais para a rota, pelo `Content-Length`.
 *
 * Precisa rodar DEPOIS do CORS e ANTES dos parsers: depois do CORS para o 413
 * chegar legível no painel em vez de virar erro de origem no console do
 * navegador, e antes dos parsers para a recusa acontecer sem bufferizar nada.
 *
 * Upload passa direto: `multipart/form-data` não é lido por estes parsers, e sim
 * pelo multer do `FileInterceptor`, que tem o teto dele (`maxBytesPlanilha`,
 * `MAX_BYTES_MIDIA`). Aplicar o teto de JSON a um upload de mídia recusaria um
 * vídeo de 16 MB perfeitamente válido.
 *
 * O que isto NÃO cobre: corpo enviado em `Transfer-Encoding: chunked`, que não
 * declara tamanho. Esse cai no `limit` do parser, e é por isso que o parser
 * ainda precisa ter um. Cliente HTTP normal — o painel, a Evolution — sempre
 * manda `Content-Length` para um corpo JSON.
 */
export function limitarCorpo(req: Request, res: Response, next: NextFunction): void {
  if (SEM_CORPO.has(req.method)) return next();

  const tipo = req.headers["content-type"] ?? "";
  if (!/application\/(json|.*\+json)|application\/x-www-form-urlencoded/i.test(tipo)) {
    return next();
  }

  const declarado = Number(req.headers["content-length"] ?? 0);
  const teto = tetoDaRota(req.method, req.path);
  if (!Number.isFinite(declarado) || declarado <= teto) return next();

  res.status(413).json({
    erro:
      `Corpo da requisição acima do limite desta rota (${Math.floor(teto / KB)} kB). ` +
      (teto === TETO_CAMPANHA
        ? `Divida o público em campanhas menores — o teto por campanha é de ` +
          `${LIMITES.maxContatosPorImportacao.toLocaleString("pt-BR")} contatos.`
        : "Envie menos dados por requisição."),
  });
}

function tetoDaRota(metodo: string, caminho: string): number {
  // `/api/campanhas/` e `/api/campanhas` são a mesma rota para o Express, que
  // não roda em modo `strict routing`.
  const alvo = caminho.length > 1 ? caminho.replace(/\/+$/, "") : caminho;
  return TETOS.find((t) => t.metodo === metodo && t.caminho === alvo)?.bytes ?? TETO_PADRAO;
}
