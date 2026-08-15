import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from "@nestjs/common";
import { z } from "zod";
import { geracaoVariacoesSchema, spintaxEntradaSchema } from "@disparoy/dominio";
import { IpOrigem, Usuario } from "../auth/usuario.decorator";
import type { UsuarioAutenticado } from "../auth/auth.guard";
import { ValidacaoZodPipe } from "../comum/validacao.pipe";
import { SpintaxService } from "./spintax.service";

@Controller("spintax")
export class SpintaxController {
  constructor(private readonly spintax: SpintaxService) {}

  @Get()
  async listar(@Usuario() usuario: UsuarioAutenticado) {
    return { spintax: await this.spintax.listar(usuario) };
  }

  /**
   * O pipe fica no `@Body()`, não em `@UsePipes` no método: lá ele roda em
   * TODOS os parâmetros, e o schema recusava o usuário autenticado e a string
   * de IP — nenhuma variação chegava a ser salva, sempre 400 "Dados inválidos".
   */
  @Post()
  async salvar(
    @Usuario() usuario: UsuarioAutenticado,
    @Body(new ValidacaoZodPipe(spintaxEntradaSchema)) corpo: z.infer<typeof spintaxEntradaSchema>,
    @IpOrigem() ip: string,
  ) {
    return { spintax: await this.spintax.salvar(usuario, corpo, ip) };
  }

  /** Só gera e devolve — quem salva é o `POST /spintax`, depois da conferência. */
  @Post("gerar")
  @HttpCode(200)
  async gerar(
    @Usuario() usuario: UsuarioAutenticado,
    @Body(new ValidacaoZodPipe(geracaoVariacoesSchema))
    corpo: z.infer<typeof geracaoVariacoesSchema>,
    @IpOrigem() ip: string,
  ) {
    return { variacoes: await this.spintax.gerar(usuario, corpo, ip) };
  }

  @Delete(":id")
  @HttpCode(200)
  async excluir(
    @Usuario() usuario: UsuarioAutenticado,
    @Param("id", ParseUUIDPipe) id: string,
    @IpOrigem() ip: string,
  ) {
    await this.spintax.excluir(usuario, id, ip);
    return { excluido: id };
  }
}
