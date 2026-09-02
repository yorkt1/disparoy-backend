import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import type { Canal } from "@disparoy/dominio";
import { SupabaseService } from "../supabase/supabase.service";
import { AuditoriaService } from "../auditoria/auditoria.service";
import { COLUNAS_CANAL, paraCanal, type LinhaCanal } from "../comum/mapeadores";
import type { UsuarioAutenticado } from "../auth/auth.guard";

export interface EmpresaResumo {
  id: string;
  nome: string;
  ativa: boolean;
  criadaEm: string;
  /** Quantos acessos pertencem a ela — zero significa empresa sem ninguém. */
  acessos: number;
  /**
   * Os canais DELA, e não a contagem.
   *
   * Era `canais: number`. Um número respondia "já conectou alguma coisa?" e
   * calava justamente na pergunta seguinte, que é a que aparece no suporte:
   * o WhatsApp deste cliente está de pé AGORA, e qual é o número? Com todos os
   * canais do sistema numa lista só, a conta global via dez linhas sem saber de
   * quem era cada uma — a resposta exigia entrar na conta do cliente.
   *
   * Vem o `Canal` inteiro porque a tela decide o selo com `apresentarCanal()`,
   * que precisa de `status`, `numero` e `estadoVerificadoEm` juntos. Mandar só
   * o `status` gravado seria devolver o cache do webhook como fato — a mentira
   * que essa função existe para não contar.
   */
  canais: Canal[];
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

    /*
     * Duas consultas para TODAS as empresas, e não duas por empresa.
     *
     * O laço anterior fazia `2n + 1` idas ao banco — com trinta clientes, são
     * sessenta e uma. Trazer tudo de uma vez e agrupar aqui cabe folgado em
     * memória: são os acessos e os canais do sistema inteiro, na casa das
     * dezenas, e a rota só responde para a conta de administração.
     *
     * As duas são deliberadamente SEM escopo de empresa — é o único lugar do
     * sistema em que isso é o objetivo, e `exigirGlobal` acima é o que garante
     * que só a conta de administração chega aqui.
     */
    const [acessos, canais] = await Promise.all([
      this.supabase.tabela("perfis").select("empresa_id"),
      this.supabase.tabela("canais").select(`${COLUNAS_CANAL}, empresa_id`).order("nome"),
    ]);

    if (acessos.error) throw new Error(`Falha ao contar acessos: ${acessos.error.message}`);
    if (canais.error) throw new Error(`Falha ao listar canais: ${canais.error.message}`);

    const porEmpresa = new Map<string, { acessos: number; canais: Canal[] }>();
    const balde = (empresaId: string) => {
      const atual = porEmpresa.get(empresaId) ?? { acessos: 0, canais: [] };
      porEmpresa.set(empresaId, atual);
      return atual;
    };

    // `empresa_id` nulo é a própria conta de administração, que não pertence a
    // empresa nenhuma — e por isso não entra na contagem de ninguém.
    for (const p of (acessos.data ?? []) as { empresa_id: string | null }[]) {
      if (p.empresa_id) balde(p.empresa_id).acessos += 1;
    }

    for (const l of (canais.data ?? []) as unknown as (LinhaCanal & {
      empresa_id: string | null;
    })[]) {
      if (l.empresa_id) balde(l.empresa_id).canais.push(paraCanal(l));
    }

    return empresas.map((e) => {
      const seus = porEmpresa.get(e.id);
      return {
        id: e.id,
        nome: e.nome,
        ativa: e.ativa,
        criadaEm: e.criada_em,
        acessos: seus?.acessos ?? 0,
        canais: seus?.canais ?? [],
      };
    });
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

    return { id: e.id, nome: e.nome, ativa: e.ativa, criadaEm: e.criada_em, acessos: 0, canais: [] };
  }
}
