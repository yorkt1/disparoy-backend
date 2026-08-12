import { Controller, Get, Query } from "@nestjs/common";
import { SomenteAdmin } from "../auth/papel.decorator";
import { AuditoriaService } from "./auditoria.service";

/**
 * Trilha de auditoria — restrita a administradores.
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
    @Query("pagina") pagina?: string,
    @Query("porPagina") porPagina?: string,
    @Query("busca") busca?: string,
    @Query("tipoEntidade") tipoEntidade?: string,
  ) {
    return this.auditoria.listar({
      pagina: pagina ? Number(pagina) : undefined,
      porPagina: porPagina ? Number(porPagina) : undefined,
      busca,
      tipoEntidade,
    });
  }
}
