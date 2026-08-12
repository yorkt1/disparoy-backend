import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from "@nestjs/common";
import { z } from "zod";
import { canalAjusteSchema, canalEntradaSchema, membroCanalSchema } from "@disparoy/dominio";
import { IpOrigem, Usuario } from "../auth/usuario.decorator";
import type { UsuarioAutenticado } from "../auth/auth.guard";
import { SomenteAdmin } from "../auth/papel.decorator";
import { ValidacaoZodPipe } from "../comum/validacao.pipe";
import { CanaisService } from "./canais.service";

@Controller("canais")
export class CanaisController {
  constructor(private readonly canais: CanaisService) {}

  @Get()
  async listar(@Usuario() usuario: UsuarioAutenticado) {
    return { canais: await this.canais.listar(usuario) };
  }

  /** Conectar número é ato administrativo: mexe em custo e em risco de ban. */
  @Post()
  @SomenteAdmin()
  criar(
    @Usuario() usuario: UsuarioAutenticado,
    @Body(new ValidacaoZodPipe(canalEntradaSchema)) corpo: z.infer<typeof canalEntradaSchema>,
    @IpOrigem() ip: string,
  ) {
    return this.canais.criar(usuario, corpo, ip);
  }

  @Post(":id/reconectar")
  @HttpCode(200)
  reconectar(@Usuario() usuario: UsuarioAutenticado, @Param("id", ParseUUIDPipe) id: string) {
    return this.canais.reconectar(usuario, id);
  }

  @Patch(":id")
  async ajustar(
    @Usuario() usuario: UsuarioAutenticado,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ValidacaoZodPipe(canalAjusteSchema)) corpo: z.infer<typeof canalAjusteSchema>,
    @IpOrigem() ip: string,
  ) {
    return { canal: await this.canais.ajustar(usuario, id, corpo, ip) };
  }

  @Delete(":id")
  @SomenteAdmin()
  @HttpCode(200)
  async excluir(
    @Usuario() usuario: UsuarioAutenticado,
    @Param("id", ParseUUIDPipe) id: string,
    @IpOrigem() ip: string,
  ) {
    await this.canais.excluir(usuario, id, ip);
    return { excluido: id };
  }

  // --- Compartilhamento entre operadores ----------------------------------

  @Get(":id/membros")
  async membros(
    @Usuario() usuario: UsuarioAutenticado,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return { membros: await this.canais.listarMembros(usuario, id) };
  }

  @Post(":id/membros")
  @SomenteAdmin()
  @HttpCode(200)
  async adicionarMembro(
    @Usuario() usuario: UsuarioAutenticado,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ValidacaoZodPipe(membroCanalSchema)) corpo: z.infer<typeof membroCanalSchema>,
  ) {
    await this.canais.definirMembro(usuario, id, corpo.perfilId, corpo.permissao);
    return { vinculado: corpo.perfilId };
  }

  @Delete(":id/membros/:perfilId")
  @SomenteAdmin()
  @HttpCode(200)
  async removerMembro(
    @Usuario() usuario: UsuarioAutenticado,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("perfilId", ParseUUIDPipe) perfilId: string,
  ) {
    await this.canais.removerMembro(usuario, id, perfilId);
    return { removido: perfilId };
  }
}
