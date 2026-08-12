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
