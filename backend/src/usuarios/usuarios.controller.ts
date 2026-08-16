import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { z } from "zod";
import { ajusteUsuarioSchema, novoUsuarioSchema } from "@disparoy/dominio";
import { IpOrigem, Usuario } from "../auth/usuario.decorator";
import type { UsuarioAutenticado } from "../auth/auth.guard";
import { SomenteAdmin } from "../auth/papel.decorator";
import { ValidacaoZodPipe } from "../comum/validacao.pipe";
import { UsuariosService } from "./usuarios.service";

/** Gestão de acessos é inteira restrita a administradores. */
@Controller("usuarios")
@SomenteAdmin()
export class UsuariosController {
  constructor(private readonly usuarios: UsuariosService) {}

  @Get()
  async listar(@Usuario() autor: UsuarioAutenticado) {
    return { usuarios: await this.usuarios.listar(autor) };
  }

  @Post()
  async criar(
    @Usuario() autor: UsuarioAutenticado,
    @Body(new ValidacaoZodPipe(novoUsuarioSchema)) corpo: z.infer<typeof novoUsuarioSchema>,
    @IpOrigem() ip: string,
  ) {
    return { usuario: await this.usuarios.criar(autor, corpo, ip) };
  }

  @Patch(":id")
  async ajustar(
    @Usuario() autor: UsuarioAutenticado,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ValidacaoZodPipe(ajusteUsuarioSchema)) corpo: z.infer<typeof ajusteUsuarioSchema>,
    @IpOrigem() ip: string,
  ) {
    return { usuario: await this.usuarios.ajustar(autor, id, corpo, ip) };
  }
}
