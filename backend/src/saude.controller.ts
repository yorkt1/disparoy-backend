import { Controller, Get } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import { Publico } from "./auth/publico.decorator";
import { Usuario } from "./auth/usuario.decorator";
import type { UsuarioAutenticado } from "./auth/auth.guard";
import { WhatsappService } from "./whatsapp/whatsapp.service";
import { SupabaseService } from "./supabase/supabase.service";

@Controller()
export class SaudeController {
  constructor(
    private readonly whatsapp: WhatsappService,
    private readonly supabase: SupabaseService,
  ) {}

  /**
   * Raiz do serviço.
   *
   * Existe só para quem abre a URL no navegador não levar um `Cannot GET /` e
   * achar que o deploy quebrou. Devolve uma frase e nada mais: não diz nome do
   * serviço, versão, prefixo das rotas nem estado de integração — é a única
   * rota que qualquer um alcança sem sequer conhecer o caminho, e não tem por
   * que contar nada sobre o sistema.
   */
  @Get()
  @Publico()
  raiz() {
    return { servico: "ok" };
  }

  /**
   * Health check do Render: leve, sem sessão e sem contar nada sobre o sistema.
   *
   * O estado das integrações saiu daqui de propósito. Esta rota é pública e a
   * URL do serviço é adivinhável, e dizer qual provedor de WhatsApp está
   * configurado é reconhecimento gratuito para quem estiver procurando alvo.
   * Quem precisa dessa informação é o painel, e o painel está autenticado —
   * ela vive em `/api/eu`.
   *
   * Fora do throttle: o Render bate aqui de poucos em poucos segundos, e o
   * teto por IP existe para navegador, não para health check. Um 429 aqui faz
   * o Render marcar o serviço como caído e reiniciar a API no meio do disparo.
   */
  @Get("saude")
  @Publico()
  @SkipThrottle()
  async saude() {
    const { error } = await this.supabase.tabela("perfis").select("id").limit(1);
    return { ok: !error, banco: error ? "indisponivel" : "ok" };
  }

  /** Dados da sessão para o topo do painel. */
  @Get("eu")
  eu(@Usuario() usuario: UsuarioAutenticado) {
    return {
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        papel: usuario.papel,
      },
      integracao: this.whatsapp.estadoIntegracao(),
    };
  }
}
