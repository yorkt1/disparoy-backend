import {
  BadRequestException,
  Controller,
  Get,
  HttpStatus,
  ParseFilePipeBuilder,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { EXTENSOES_PLANILHA, LIMITES } from "@disparoy/dominio";
import { Publico } from "../auth/publico.decorator";
import { ErroPlanilha, gerarPlanilhaModelo, lerPlanilha } from "./planilha";

/**
 * O que sobrou de contatos depois que o cadastro deixou de existir.
 *
 * O público vive dentro da campanha, vindo de planilha ou colagem — não há mais
 * base a listar, importar ou excluir. Ficaram só as duas rotas que servem esse
 * fluxo:
 *
 *  - `ler-planilha`, que apenas PARSEIA o arquivo e devolve as linhas. Nada é
 *    gravado; a montagem dos contatos acontece no cliente, com as funções do
 *    domínio.
 *  - `modelo`, o arquivo em branco com o cabeçalho certo.
 *
 * O opt-out não está aqui porque deixou de ser operação sobre um contato: ele
 * chega pelo webhook, ou pela tela da campanha, e vive em `opt_outs`.
 */
@Controller()
export class ContatosController {
  /**
   * Lê a planilha e devolve as linhas normalizadas.
   *
   * Só o parse acontece aqui — a montagem dos contatos roda no cliente, para o
   * mapeamento de colunas recalcular sem novo upload.
   */
  @Post("contatos/ler-planilha")
  @UseInterceptors(FileInterceptor("arquivo", { limits: { fileSize: LIMITES.maxBytesPlanilha } }))
  lerPlanilha(
    @UploadedFile(
      new ParseFilePipeBuilder()
        .addMaxSizeValidator({ maxSize: LIMITES.maxBytesPlanilha })
        .build({ errorHttpStatusCode: HttpStatus.PAYLOAD_TOO_LARGE, fileIsRequired: true }),
    )
    arquivo: Express.Multer.File,
  ) {
    const extensao = arquivo.originalname.slice(arquivo.originalname.lastIndexOf(".")).toLowerCase();
    if (!EXTENSOES_PLANILHA.includes(extensao as (typeof EXTENSOES_PLANILHA)[number])) {
      throw new BadRequestException(`Formato não aceito. Use ${EXTENSOES_PLANILHA.join(", ")}.`);
    }

    try {
      return lerPlanilha(arquivo.buffer, arquivo.originalname);
    } catch (e) {
      if (e instanceof ErroPlanilha) throw new BadRequestException(e.message);
      throw new BadRequestException("Não foi possível interpretar a planilha.");
    }
  }

  /**
   * Planilha-modelo. Pública porque é um `<a download>` do navegador, que não
   * envia o header Authorization — e o conteúdo é estático.
   */
  @Get("contatos/modelo")
  @Publico()
  baixarModelo(@Res() res: Response) {
    res
      .status(200)
      .set({
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": 'attachment; filename="modelo-contatos-disparoy.xlsx"',
        "Cache-Control": "public, max-age=3600",
      })
      .send(Buffer.from(gerarPlanilhaModelo()));
  }
}
