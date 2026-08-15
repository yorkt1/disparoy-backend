import { Controller, Get, Param, ParseIntPipe, Post, Query } from "@nestjs/common";
import { Usuario } from "../auth/usuario.decorator";
import type { UsuarioAutenticado } from "../auth/auth.guard";
import { AvisosService } from "./avisos.service";

/**
 * Caixa de avisos do próprio usuário.
 *
 * Não existe rota para ler a caixa de outra pessoa, nem por admin: `@Usuario()`
 * vem do token validado pelo `AuthGuard`, e o serviço filtra por ele em toda
 * consulta. Aceitar `perfilId` por parâmetro seria abrir a caixa de qualquer um
 * para qualquer um — a API roda com service role e ignora RLS.
 */
@Controller("avisos")
export class AvisosController {
  constructor(private readonly avisos: AvisosService) {}

  @Get()
  listar(@Usuario() usuario: UsuarioAutenticado, @Query("incluirLidos") incluirLidos?: string) {
    return this.avisos.listar(usuario, incluirLidos === "true");
  }

  /** Só a contagem: é chamada com frequência e o payload cheio seria desperdício. */
  @Get("contagem")
  contar(@Usuario() usuario: UsuarioAutenticado) {
    return this.avisos.contarNaoLidos(usuario);
  }

  @Get("incidentes")
  incidentes(@Usuario() usuario: UsuarioAutenticado) {
    return this.avisos.incidentesAbertos(usuario);
  }

  @Post("lidos")
  async marcarTodos(@Usuario() usuario: UsuarioAutenticado) {
    await this.avisos.marcarTodosLidos(usuario);
    return { ok: true };
  }

  @Post(":id/lido")
  async marcarLido(
    @Usuario() usuario: UsuarioAutenticado,
    @Param("id", ParseIntPipe) id: number,
  ) {
    await this.avisos.marcarLido(usuario, id);
    return { ok: true };
  }

  @Post(":id/arquivar")
  async arquivar(@Usuario() usuario: UsuarioAutenticado, @Param("id", ParseIntPipe) id: number) {
    await this.avisos.arquivar(usuario, id);
    return { ok: true };
  }
}
