import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { SupabaseService } from "../supabase/supabase.service";
import { AuditoriaService } from "../auditoria/auditoria.service";
import type { UsuarioAutenticado } from "../auth/auth.guard";

export interface EmpresaResumo {
  id: string;
  nome: string;
  ativa: boolean;
  criadaEm: string;
  /** Quantos acessos pertencem a ela — zero significa empresa sem ninguém. */
  acessos: number;
  canais: number;
}

/**
 * Empresas e os acessos que pertencem a elas.
 *
 * O desenho do produto: existe UMA conta de administração — a do `.env` — e é
 * só ela que cria empresas e os logins de cada uma. As empresas não se
 * cadastram nem convidam ninguém; elas recebem um acesso pronto, conectam o
 * próprio WhatsApp e disparam dentro do que é delas.
 *
 * Por isso tudo aqui é restrito à conta global. Um admin DE UMA empresa não
 * pode criar outra: seria abrir a porta para enxergar além do próprio escopo.
 */
@Injectable()
export class EmpresasService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /**
   * Só a conta global administra empresas.
   *
   * `papel === "admin"` não basta: cada empresa pode ter o próprio admin, e ele
   * é administrador DELA, não do sistema. O que distingue a conta de
   * administração é não pertencer a empresa nenhuma.
   */
  private exigirGlobal(usuario: UsuarioAutenticado): void {
    if (usuario.empresaId !== null) {
      throw new BadRequestException(
        "Só a conta de administração do sistema pode gerenciar empresas.",
      );
    }
  }

  async listar(usuario: UsuarioAutenticado): Promise<EmpresaResumo[]> {
    this.exigirGlobal(usuario);

    const { data, error } = await this.supabase
      .tabela("empresas")
      .select("id, nome, ativa, criada_em")
      .order("criada_em");

    if (error) throw new Error(`Falha ao listar empresas: ${error.message}`);

    const empresas = (data ?? []) as {
      id: string;
      nome: string;
      ativa: boolean;
      criada_em: string;
    }[];

    // Duas contagens por empresa: quantos entram e quantos números ela tem.
    // São as duas perguntas que a tela responde — "já existe acesso?" e "já
    // conectou WhatsApp?".
    return Promise.all(
      empresas.map(async (e) => {
        const [{ count: acessos }, { count: canais }] = await Promise.all([
          this.supabase
            .tabela("perfis")
            .select("id", { count: "exact", head: true })
            .eq("empresa_id", e.id),
          this.supabase
            .tabela("canais")
            .select("id", { count: "exact", head: true })
            .eq("empresa_id", e.id),
        ]);
        return {
          id: e.id,
          nome: e.nome,
          ativa: e.ativa,
          criadaEm: e.criada_em,
          acessos: acessos ?? 0,
          canais: canais ?? 0,
        };
      }),
    );
  }

  async criar(usuario: UsuarioAutenticado, nome: string, ip: string): Promise<EmpresaResumo> {
    this.exigirGlobal(usuario);

    const { data, error } = await this.supabase
      .tabela("empresas")
      .insert({ nome: nome.trim() })
      .select("id, nome, ativa, criada_em")
      .single();

    if (error?.code === "23505") {
      throw new ConflictException("Já existe uma empresa com esse nome.");
    }
    if (error) throw new Error(`Falha ao criar empresa: ${error.message}`);

    const e = data as { id: string; nome: string; ativa: boolean; criada_em: string };

    await this.auditoria.registrar({
      usuarioId: usuario.id,
      usuarioNome: usuario.nome,
      acao: "empresa.criada",
      tipoEntidade: "empresa",
      entidadeId: e.id,
      entidadeRotulo: e.nome,
      ip,
    });

    return { id: e.id, nome: e.nome, ativa: e.ativa, criadaEm: e.criada_em, acessos: 0, canais: 0 };
  }
}
