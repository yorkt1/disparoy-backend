import { Controller, Get } from "@nestjs/common";
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
    return { mensagem: "talvez tenha alguma vulnerabilidade :)" };
  }

  /** Health check do Render: precisa ser leve e não exigir sessão. */
  @Get("saude")
  @Publico()
  async saude() {
    const { error } = await this.supabase.tabela("perfis").select("id").limit(1);
    return {
      ok: !error,
      banco: error ? "indisponivel" : "ok",
      integracao: this.whatsapp.estadoIntegracao(),
    };
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
