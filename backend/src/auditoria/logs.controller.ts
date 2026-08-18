import { Controller, Get, Query } from "@nestjs/common";
import { SomenteAdmin } from "../auth/papel.decorator";
import { Usuario } from "../auth/usuario.decorator";
import type { UsuarioAutenticado } from "../auth/auth.guard";
import { AuditoriaService } from "./auditoria.service";

/**
 * Trilha de auditoria — restrita a administradores.
 *
 * "Administrador" não é só a conta global: um admin de empresa também tem o
 * papel `admin` e passa por `@SomenteAdmin()`. O que separa um do outro é o
 * `noEscopo` dentro de `auditoria.listar` — a conta global (`empresaId ===
 * null`) vê a trilha inteira, de propósito, porque é o acesso de suporte;
 * qualquer outro admin só enxerga o histórico da própria empresa. Sem isso a
 * rota vazava o histórico de uma empresa para o admin de outra.
 *
 * Os detalhes de cada evento incluem IP e metadados de importação, que são
 * material de investigação e não informação de operação diária.
 */
@Controller("logs")
@SomenteAdmin()
export class LogsController {
  constructor(private readonly auditoria: AuditoriaService) {}

  @Get()
  listar(
    @Usuario() usuario: UsuarioAutenticado,
    @Query("pagina") pagina?: string,
    @Query("porPagina") porPagina?: string,
    @Query("busca") busca?: string,
    @Query("tipoEntidade") tipoEntidade?: string,
  ) {
    return this.auditoria.listar(usuario, {
      pagina: pagina ? Number(pagina) : undefined,
      porPagina: porPagina ? Number(porPagina) : undefined,
      busca,
      tipoEntidade,
    });
  }
}
