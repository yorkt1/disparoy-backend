import { Body, Controller, HttpCode, Patch, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { loginSchema } from "@disparoy/dominio";
import { ValidacaoZodPipe } from "../comum/validacao.pipe";
import { IpOrigem, Usuario } from "./usuario.decorator";
import type { UsuarioAutenticado } from "./auth.guard";
import { Publico } from "./publico.decorator";
import { SessaoService } from "./sessao.service";

/**
 * Definido aqui, e não em `@disparoy/dominio`, de propósito.
 *
 * O pacote compartilhado existe para o que a API e o painel precisam
 * concordar — e ele está duplicado nos dois repositórios, então cada schema
 * novo lá vira dois arquivos para manter em sincronia. O painel só precisa
 * postar dois campos e ler a mensagem de erro; não há regra para compartilhar.
 *
 * O mínimo de 8 é maior que o de 6 usado no cadastro feito pelo admin: ali a
 * senha é provisória e trocada no primeiro acesso, aqui ela é a definitiva.
 */
const trocaSenhaSchema = z.object({
  senhaAtual: z.string().min(1, "Informe a senha atual."),
  novaSenha: z.string().min(8, "A nova senha precisa ter pelo menos 8 caracteres.").max(200),
});

@Controller("sessao")
export class SessaoController {
  constructor(private readonly sessao: SessaoService) {}

  /**
   * Login. Público por necessidade — é a porta de entrada.
   *
   * Teto próprio, bem abaixo do global: a rota de login é a única em que
   * tentativa repetida é o ataque em si, e 10 por minuto não atrapalha quem
   * está só errando a senha.
   */
  @Post()
  @Publico()
  @Throttle({ curta: { ttl: 60_000, limit: 10 }, longa: { ttl: 900_000, limit: 60 } })
  async entrar(
    @Body(new ValidacaoZodPipe(loginSchema)) corpo: z.infer<typeof loginSchema>,
    @IpOrigem() ip: string,
  ) {
    return this.sessao.entrar(corpo.email, corpo.senha, ip);
  }

  /**
   * Troca da própria senha. Autenticada — cai no `AuthGuard` global.
   *
   * Mesmo teto do login: quem tem o token mas não a senha atual pode ficar
   * tentando adivinhá-la aqui, e o efeito de acertar é o mesmo de acertar no
   * login — só que sem o e-mail para descobrir.
   */
  @Patch("senha")
  @HttpCode(204)
  @Throttle({ curta: { ttl: 60_000, limit: 10 }, longa: { ttl: 900_000, limit: 60 } })
  async trocarSenha(
    @Usuario() usuario: UsuarioAutenticado,
    @Body(new ValidacaoZodPipe(trocaSenhaSchema)) corpo: z.infer<typeof trocaSenhaSchema>,
    @IpOrigem() ip: string,
  ): Promise<void> {
    await this.sessao.trocarPropriaSenha(usuario, corpo.senhaAtual, corpo.novaSenha, ip);
  }
}
