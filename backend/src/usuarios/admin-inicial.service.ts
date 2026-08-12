import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { SupabaseService } from "../supabase/supabase.service";
import { ambiente } from "../config/ambiente";
import { gerarHash } from "../auth/senha";

/**
 * Garante o administrador inicial no boot da API.
 *
 * Sem auto-cadastro, a instalação nasceria travada: ninguém entraria para criar
 * o primeiro acesso. Este serviço fecha esse buraco lendo ADMIN_EMAIL e
 * ADMIN_SENHA do ambiente.
 *
 * Roda só na API — o worker não importa este módulo, então subir várias
 * instâncias do worker não dispara nada aqui.
 *
 * **Cria uma vez, nunca sobrescreve a senha.** Se a conta já existe, a senha do
 * .env é ignorada: caso contrário, todo restart desfaria em silêncio uma troca
 * feita pela tela — e um .env vazado viraria uma porta permanente. Promover
 * para admin e reativar, sim: é o resgate de quem se trancou para fora.
 */
@Injectable()
export class AdminInicialService implements OnModuleInit {
  private readonly log = new Logger(AdminInicialService.name);

  constructor(private readonly supabase: SupabaseService) {}

  async onModuleInit(): Promise<void> {
    const env = ambiente();
    const email = env.ADMIN_EMAIL?.trim().toLowerCase();

    if (!email || !env.ADMIN_SENHA) {
      await this.avisarSeNaoHaAdmin();
      return;
    }

    const { data: existente, error: erroConsulta } = await this.supabase
      .tabela("perfis")
      .select("id, papel, ativo")
      .eq("email", email)
      .maybeSingle();

    if (erroConsulta) {
      this.log.error(`Não foi possível verificar o admin inicial: ${erroConsulta.message}`);
      return;
    }

    if (existente) {
      await this.promover(existente as { id: string; papel: string; ativo: boolean }, email);
      return;
    }

    const { error } = await this.supabase.tabela("perfis").insert({
      nome: env.ADMIN_NOME,
      email,
      papel: "admin",
      ativo: true,
      senha_hash: await gerarHash(env.ADMIN_SENHA),
    });

    if (error) {
      this.log.error(`Falha ao criar o admin inicial (${email}): ${error.message}`);
      return;
    }

    this.log.log(`Administrador inicial criado: ${email}`);
  }

  /** Reaproveita a conta que já existe, sem tocar na senha. */
  private async promover(
    perfil: { id: string; papel: string; ativo: boolean },
    email: string,
  ): Promise<void> {
    if (perfil.papel === "admin" && perfil.ativo) return;

    const { error } = await this.supabase
      .tabela("perfis")
      .update({ papel: "admin", ativo: true })
      .eq("id", perfil.id);

    if (error) {
      this.log.error(`Não foi possível promover ${email} a admin: ${error.message}`);
      return;
    }

    this.log.warn(`${email} já existia e foi promovido a admin ativo. A senha do .env foi ignorada.`);
  }

  /** Instalação sem ADMIN_EMAIL e sem nenhum admin ativo não tem como ser usada. */
  private async avisarSeNaoHaAdmin(): Promise<void> {
    const { count, error } = await this.supabase
      .tabela("perfis")
      .select("id", { count: "exact", head: true })
      .eq("papel", "admin")
      .eq("ativo", true);

    if (error || (count ?? 0) > 0) return;

    this.log.warn(
      "Nenhum administrador ativo e ADMIN_EMAIL/ADMIN_SENHA não configurados: " +
        "ninguém consegue entrar. Preencha os dois em backend/.env e reinicie a API.",
    );
  }
}
