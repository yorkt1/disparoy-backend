import { Body, Controller, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { loginSchema } from "@disparoy/dominio";
import { ValidacaoZodPipe } from "../comum/validacao.pipe";
import { IpOrigem } from "./usuario.decorator";
import { Publico } from "./publico.decorator";
import { SessaoService } from "./sessao.service";

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
}
