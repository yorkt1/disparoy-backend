import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseFilePipeBuilder,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { z } from "zod";
import {
  EXTENSOES_PLANILHA,
  LIMITES,
  importacaoContatosSchema,
  listaEntradaSchema,
  optOutManualSchema,
} from "@disparoy/dominio";
import { IpOrigem, Usuario } from "../auth/usuario.decorator";
import type { UsuarioAutenticado } from "../auth/auth.guard";
import { Publico } from "../auth/publico.decorator";
import { ValidacaoZodPipe } from "../comum/validacao.pipe";
import { ErroPlanilha, gerarPlanilhaModelo, lerPlanilha } from "./planilha";
import { ContatosService, type ConsultaContatos } from "./contatos.service";

@Controller()
export class ContatosController {
  constructor(private readonly contatos: ContatosService) {}

  // --- Contatos -----------------------------------------------------------

  @Get("contatos")
  listar(
    @Query("pagina") pagina?: string,
    @Query("porPagina") porPagina?: string,
    @Query("busca") busca?: string,
    @Query("situacao") situacao?: string,
  ) {
    return this.contatos.listar({
      pagina: pagina ? Number(pagina) : undefined,
      porPagina: porPagina ? Number(porPagina) : undefined,
      busca,
      situacao: situacao as ConsultaContatos["situacao"],
    });
  }

  /**
   * Lê a planilha e devolve as linhas normalizadas.
   *
   * Só o parse acontece aqui — a montagem dos contatos roda no cliente, para o
   * mapeamento de colunas recalcular sem novo upload. Nada é gravado nesta
   * etapa: sem consentimento declarado, não existe contato.
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

  @Post("contatos/importar")
  importar(
    @Usuario() usuario: UsuarioAutenticado,
    @Body(new ValidacaoZodPipe(importacaoContatosSchema))
    corpo: z.infer<typeof importacaoContatosSchema>,
    @IpOrigem() ip: string,
  ) {
    return this.contatos.importar(usuario, corpo, ip);
  }

  @Post("contatos/:id/opt-out")
  @HttpCode(200)
  async optOut(
    @Usuario() usuario: UsuarioAutenticado,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ValidacaoZodPipe(optOutManualSchema)) corpo: z.infer<typeof optOutManualSchema>,
    @IpOrigem() ip: string,
  ) {
    const alvo = await this.contatos.obter(id);
    const registrado = await this.contatos.registrarOptOut(usuario, alvo.telefone, corpo.motivo, ip);
    return { registrado };
  }

  @Delete("contatos/:id")
  @HttpCode(200)
  async excluir(
    @Usuario() usuario: UsuarioAutenticado,
    @Param("id", ParseUUIDPipe) id: string,
    @IpOrigem() ip: string,
  ) {
    await this.contatos.excluir(usuario, id, ip);
    return { excluido: id };
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

  // --- Listas -------------------------------------------------------------

  @Get("listas")
  async listarListas() {
    return { listas: await this.contatos.listarListas() };
  }

  @Post("listas")
  async criarLista(
    @Usuario() usuario: UsuarioAutenticado,
    @Body(new ValidacaoZodPipe(listaEntradaSchema)) corpo: z.infer<typeof listaEntradaSchema>,
    @IpOrigem() ip: string,
  ) {
    return { lista: await this.contatos.criarLista(usuario, corpo, ip) };
  }

  @Delete("listas/:id")
  @HttpCode(200)
  async excluirLista(
    @Usuario() usuario: UsuarioAutenticado,
    @Param("id", ParseUUIDPipe) id: string,
    @IpOrigem() ip: string,
  ) {
    await this.contatos.excluirLista(usuario, id, ip);
    return { excluido: id };
  }
}
