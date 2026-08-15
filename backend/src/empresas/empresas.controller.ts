import { Body, Controller, Get, Post } from "@nestjs/common";
import { z } from "zod";
import { IpOrigem, Usuario } from "../auth/usuario.decorator";
import type { UsuarioAutenticado } from "../auth/auth.guard";
import { SomenteAdmin } from "../auth/papel.decorator";
import { ValidacaoZodPipe } from "../comum/validacao.pipe";
import { EmpresasService } from "./empresas.service";

const empresaEntradaSchema = z.object({
  nome: z.string().trim().min(2).max(120),
});

/**
 * Empresas do sistema.
 *
 * `@SomenteAdmin()` é a primeira barreira; a segunda, dentro do serviço, exige
 * que a conta seja GLOBAL. As duas são necessárias: admin de uma empresa passa
 * pela primeira e precisa parar na segunda.
 */
@Controller("empresas")
@SomenteAdmin()
export class EmpresasController {
  constructor(private readonly empresas: EmpresasService) {}

  @Get()
  async listar(@Usuario() usuario: UsuarioAutenticado) {
    return { empresas: await this.empresas.listar(usuario) };
  }

  @Post()
  async criar(
    @Usuario() usuario: UsuarioAutenticado,
    @Body(new ValidacaoZodPipe(empresaEntradaSchema)) corpo: z.infer<typeof empresaEntradaSchema>,
    @IpOrigem() ip: string,
  ) {
    return { empresa: await this.empresas.criar(usuario, corpo.nome, ip) };
  }
}
