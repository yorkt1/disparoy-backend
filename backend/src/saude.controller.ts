import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
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
    if (error) {
      throw new ServiceUnavailableException({ ok: false, banco: "indisponivel" });
    }

    return { ok: true, banco: "ok" };
  }

  /** Dados da sessão para o topo do painel. */
  @Get("eu")
  async eu(@Usuario() usuario: UsuarioAutenticado) {
    return {
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        papel: usuario.papel,
        /**
         * `null` é a conta de administração do sistema.
         *
         * O painel precisa distinguir isso de `papel: "admin"`: cada empresa
         * cliente tem o próprio admin, e ele administra a EMPRESA. Só quem não
         * pertence a nenhuma administra o sistema.
         */
        empresaId: usuario.empresaId,
      },
      integracao: this.whatsapp.estadoIntegracao(),
      disparo: await this.estadoDisparo(),
    };
  }

  /**
   * O worker está vivo?
   *
   * Fica em `/eu` e não em `/saude` pelo mesmo motivo que o estado das
   * integrações: `/saude` é pública e não conta nada sobre o sistema. Quem
   * precisa saber é o painel, que está autenticado.
   *
   * A manutenção roda de minuto em minuto. A tolerância de 3 minutos evita que
   * um ciclo atrasado vire alarme falso, e ainda assim avisa antes de a
   * primeira campanha ficar parada sem ninguém perceber.
   */
  private async estadoDisparo(): Promise<{ pulsoEm: string | null; ativo: boolean }> {
    const { data, error } = await this.supabase
      .tabela("worker_pulso")
      .select("batida_em")
      .eq("id", 1)
      .maybeSingle();

    // Tabela ausente (migration não aplicada) ou erro de leitura: reportar como
    // inativo. Um alarme falso custa uma faixa a mais na tela; esconder um
    // worker morto custa campanhas que nunca saem.
    if (error || !data) return { pulsoEm: null, ativo: false };

    const pulso = (data as { batida_em: string }).batida_em;
    return { pulsoEm: pulso, ativo: Date.now() - new Date(pulso).getTime() < 3 * 60_000 };
  }
}
