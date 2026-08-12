import { Body, Controller, Get, HttpCode, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { templateEntradaSchema, type CategoriaTemplate, type StatusTemplate } from "@disparoy/dominio";
import { IpOrigem, Usuario } from "../auth/usuario.decorator";
import type { UsuarioAutenticado } from "../auth/auth.guard";
import { ValidacaoZodPipe } from "../comum/validacao.pipe";
import { TemplatesService } from "./templates.service";

@Controller("templates")
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  async listar(
    @Query("categoria") categoria?: string,
    @Query("status") status?: string,
    @Query("busca") busca?: string,
  ) {
    return {
      templates: await this.templates.listar({
        categoria: categoria as CategoriaTemplate | "todas" | undefined,
        status: status as StatusTemplate | "todos" | undefined,
        busca,
      }),
    };
  }

  /** Pipe no `@Body()`: em `@UsePipes` ele valida também o usuário e o IP. */
  @Post()
  async criar(
    @Usuario() usuario: UsuarioAutenticado,
    @Body(new ValidacaoZodPipe(templateEntradaSchema)) corpo: z.infer<typeof templateEntradaSchema>,
    @IpOrigem() ip: string,
  ) {
    return { template: await this.templates.criar(usuario, corpo, ip) };
  }

  @Post("sincronizar")
  @HttpCode(200)
  sincronizar(@Usuario() usuario: UsuarioAutenticado, @IpOrigem() ip: string) {
    return this.templates.sincronizar(usuario, ip);
  }
}
