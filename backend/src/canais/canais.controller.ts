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
  Query,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import {
  canalAjusteSchema,
  canalEntradaSchema,
  membroCanalSchema,
  reconexaoCanalSchema,
} from "@disparoy/dominio";
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
  reconectar(
    @Usuario() usuario: UsuarioAutenticado,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ValidacaoZodPipe(reconexaoCanalSchema))
    corpo: z.infer<typeof reconexaoCanalSchema>,
  ) {
    return this.canais.reconectar(usuario, id, {
      metodo: corpo.metodoPareamento,
      numero: corpo.numeroPareamento,
      forcar: corpo.forcar,
    });
  }

  /**
   * Confere a sessão contra o gateway, sob demanda.
   *
   * Não é `@SomenteAdmin()`: quem opera o canal é quem descobre que ele caiu, e
   * a rota só LÊ do gateway — o acesso ao canal já é conferido no serviço.
   */
  @Post(":id/verificar")
  @HttpCode(200)
  verificar(@Usuario() usuario: UsuarioAutenticado, @Param("id", ParseUUIDPipe) id: string) {
    return this.canais.verificar(usuario, id);
  }

  /**
   * O serviço já devolve `{ canal, aviso? }`, então o retorno é repassado
   * inteiro em vez de reembrulhado. O corpo continua `{ canal }` para quem só
   * lê o canal — `aviso` é acrescentado, e só aparece quando existe.
   */
  @Patch(":id")
  ajustar(
    @Usuario() usuario: UsuarioAutenticado,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ValidacaoZodPipe(canalAjusteSchema)) corpo: z.infer<typeof canalAjusteSchema>,
    @IpOrigem() ip: string,
  ) {
    return this.canais.ajustar(usuario, id, corpo, ip);
  }

  /**
   * Baixa a agenda do número em planilha.
   *
   * `@Res()` porque a resposta é binária, não JSON. Não é `@Publico()` como a
   * rota do modelo: aquela serve um arquivo estático, esta devolve a agenda
   * pessoal de alguém — e por isso o painel busca com o token e monta o
   * download, em vez de usar um `<a download>` que não manda cabeçalho.
   */
  @Get(":id/contatos.xlsx")
  async extrairContatos(
    @Usuario() usuario: UsuarioAutenticado,
    @Param("id", ParseUUIDPipe) id: string,
    @IpOrigem() ip: string,
    @Res() res: Response,
  ) {
    const { arquivo, nome, total } = await this.canais.extrairContatos(usuario, id, ip);
    res
      .status(200)
      .set({
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${nome}"`,
        // Lido pelo painel para avisar quantos vieram — o corpo é binário e
        // não tem onde carregar esse número.
        "X-Total-Contatos": String(total),
        "Access-Control-Expose-Headers": "X-Total-Contatos",
        "Cache-Control": "no-store",
      })
      .send(Buffer.from(arquivo));
  }

  /**
   * Quantos contatos a agenda tem agora — sem baixar o arquivo.
   *
   * A tela chama em laço logo depois do pareamento, enquanto o WhatsApp ainda
   * sincroniza a agenda com o gateway.
   */
  @Get(":id/contatos/contagem")
  contarContatos(@Usuario() usuario: UsuarioAutenticado, @Param("id", ParseUUIDPipe) id: string) {
    return this.canais.contarContatos(usuario, id);
  }

  /** Campanhas que dependem do canal — consultado antes de confirmar a exclusão. */
  @Get(":id/vinculos")
  async vinculos(@Usuario() usuario: UsuarioAutenticado, @Param("id", ParseUUIDPipe) id: string) {
    return { campanhas: await this.canais.vinculos(usuario, id) };
  }

  @Delete(":id")
  @SomenteAdmin()
  @HttpCode(200)
  async excluir(
    @Usuario() usuario: UsuarioAutenticado,
    @Param("id", ParseUUIDPipe) id: string,
    @IpOrigem() ip: string,
    /** `?forcar=true` desvincula as campanhas junto. A tela já confirmou. */
    @Query("forcar") forcar?: string,
  ) {
    await this.canais.excluir(usuario, id, ip, forcar === "true");
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
