import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from "@nestjs/common";
import { campanhaEntradaSchema, type CampanhaEntrada, type StatusCampanha } from "@disparoy/dominio";
import { IpOrigem, Usuario } from "../auth/usuario.decorator";
import type { UsuarioAutenticado } from "../auth/auth.guard";
import { ValidacaoZodPipe } from "../comum/validacao.pipe";
import { CampanhasService } from "./campanhas.service";

@Controller("campanhas")
export class CampanhasController {
  constructor(private readonly campanhas: CampanhasService) {}

  @Get()
  listar(
    @Usuario() usuario: UsuarioAutenticado,
    @Query("pagina") pagina?: string,
    @Query("porPagina") porPagina?: string,
    @Query("busca") busca?: string,
    @Query("status") status?: string,
  ) {
    return this.campanhas.listar(usuario, {
      pagina: pagina ? Number(pagina) : undefined,
      porPagina: porPagina ? Number(porPagina) : undefined,
      busca,
      status: status as StatusCampanha | "todas" | undefined,
    });
  }

  @Get("metricas")
  metricas(@Usuario() usuario: UsuarioAutenticado) {
    return this.campanhas.metricasDashboard(usuario);
  }

  @Get(":id")
  async obter(@Usuario() usuario: UsuarioAutenticado, @Param("id", ParseUUIDPipe) id: string) {
    const [campanha, contatos] = await Promise.all([
      this.campanhas.obter(usuario, id),
      this.campanhas.amostraDeContatos(usuario, id),
    ]);
    return { campanha, contatos };
  }

  @Post()
  async criar(
    @Usuario() usuario: UsuarioAutenticado,
    @Body(new ValidacaoZodPipe(campanhaEntradaSchema)) corpo: CampanhaEntrada,
    @IpOrigem() ip: string,
  ) {
    return { campanha: await this.campanhas.criar(usuario, corpo, ip) };
  }

  @Post(":id/pausar")
  @HttpCode(200)
  async pausar(
    @Usuario() usuario: UsuarioAutenticado,
    @Param("id", ParseUUIDPipe) id: string,
    @IpOrigem() ip: string,
  ) {
    return { campanha: await this.campanhas.pausar(usuario, id, ip) };
  }

  @Post(":id/retomar")
  @HttpCode(200)
  async retomar(
    @Usuario() usuario: UsuarioAutenticado,
    @Param("id", ParseUUIDPipe) id: string,
    @IpOrigem() ip: string,
  ) {
    return { campanha: await this.campanhas.retomar(usuario, id, ip) };
  }
}
