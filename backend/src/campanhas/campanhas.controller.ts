import {
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Delete,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import {
  campanhaEdicaoSchema,
  campanhaEntradaSchema,
  type CampanhaEdicao,
  type CampanhaEntrada,
  type SituacaoContato,
  type StatusCampanha,
} from "@disparoy/dominio";
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

  /**
   * Os contatos da campanha, com filtro por situação.
   *
   * Separada de `GET /campanhas/:id` de propósito: aquela rota carrega a tela
   * inteira e é repetida a cada 10 s enquanto a campanha roda. Esta muda de
   * página e de filtro por conta própria, e juntá-las faria trocar de filtro
   * recarregar métrica, gráfico e sequência.
   */
  @Get(":id/contatos")
  contatos(
    @Usuario() usuario: UsuarioAutenticado,
    @Param("id", ParseUUIDPipe) id: string,
    @Query("pagina") pagina?: string,
    @Query("porPagina") porPagina?: string,
    @Query("situacao") situacao?: string,
    @Query("busca") busca?: string,
  ) {
    return this.campanhas.contatosDaCampanha(usuario, id, {
      pagina: pagina ? Number(pagina) : undefined,
      porPagina: porPagina ? Number(porPagina) : undefined,
      situacao: situacao as SituacaoContato | "todas" | undefined,
      busca,
    });
  }

  @Post()
  async criar(
    @Usuario() usuario: UsuarioAutenticado,
    @Body(new ValidacaoZodPipe(campanhaEntradaSchema)) corpo: CampanhaEntrada,
    @IpOrigem() ip: string,
  ) {
    return { campanha: await this.campanhas.criar(usuario, corpo, ip) };
  }

  @Patch(":id")
  async editar(
    @Usuario() usuario: UsuarioAutenticado,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ValidacaoZodPipe(campanhaEdicaoSchema)) corpo: CampanhaEdicao,
    @IpOrigem() ip: string,
  ) {
    return { campanha: await this.campanhas.editar(usuario, id, corpo, ip) };
  }

  @Delete(":id")
  @HttpCode(200)
  async excluir(
    @Usuario() usuario: UsuarioAutenticado,
    @Param("id", ParseUUIDPipe) id: string,
    @IpOrigem() ip: string,
  ) {
    return { excluido: await this.campanhas.excluir(usuario, id, ip) };
  }

  /**
   * Cópia da campanha, sempre em rascunho.
   *
   * `@Post` sem corpo: não há nada a escolher — o que se duplica é a campanha
   * inteira, e um corpo com "o que copiar" seria a tela de criação de novo.
   */
  @Post(":id/duplicar")
  @HttpCode(201)
  async duplicar(
    @Usuario() usuario: UsuarioAutenticado,
    @Param("id", ParseUUIDPipe) id: string,
    @IpOrigem() ip: string,
  ) {
    return { campanha: await this.campanhas.duplicar(usuario, id, ip) };
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

  /**
   * Relatório da campanha em CSV.
   *
   * `@Res()` porque a resposta é arquivo, não JSON — mesmo arranjo do download
   * da agenda em `canais.controller`. E, como lá, não é rota pública: leva
   * telefone e texto de resposta de gente real, então o painel busca com o
   * token e monta o download no navegador.
   *
   * `charset=utf-8` declarado junto com o BOM que `montarCsv` escreve: o Excel
   * ignora o cabeçalho HTTP e olha o BOM, o resto do mundo faz o contrário.
   */
  @Get(":id/relatorio.csv")
  async relatorio(
    @Usuario() usuario: UsuarioAutenticado,
    @Param("id", ParseUUIDPipe) id: string,
    @IpOrigem() ip: string,
    @Res() res: Response,
  ) {
    const { arquivo, nome, total } = await this.campanhas.relatorio(usuario, id, ip);
    res
      .status(200)
      .set({
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${nome}"`,
        // Mesmo cabeçalho que o download da agenda usa, e lido pelo mesmo
        // `baixarArquivo` no painel: o corpo é arquivo e não tem onde carregar
        // a contagem que o aviso na tela mostra.
        "X-Total-Contatos": String(total),
        "Access-Control-Expose-Headers": "X-Total-Contatos",
        "Cache-Control": "no-store",
      })
      .send(arquivo);
  }
}
