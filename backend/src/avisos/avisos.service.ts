import { Injectable, Logger } from "@nestjs/common";
import type { Aviso, CategoriaFalha, Incidente } from "@disparoy/dominio";
import { SupabaseService } from "../supabase/supabase.service";
import type { UsuarioAutenticado } from "../auth/auth.guard";

const COLUNAS_AVISO =
  "id, incidente_id, tipo, categoria, codigo, titulo, corpo, canal_id, campanha_id, " +
  "criada_em, lida_em, canais(nome)";

interface LinhaAviso {
  id: number;
  incidente_id: number | null;
  tipo: "abertura" | "resolucao";
  categoria: CategoriaFalha;
  codigo: string;
  titulo: string;
  corpo: string;
  canal_id: string | null;
  campanha_id: string | null;
  criada_em: string;
  lida_em: string | null;
  canais: { nome: string } | null;
}

function paraAviso(l: LinhaAviso): Aviso {
  return {
    id: l.id,
    incidenteId: l.incidente_id,
    tipo: l.tipo,
    categoria: l.categoria,
    codigo: l.codigo,
    titulo: l.titulo,
    corpo: l.corpo,
    canalId: l.canal_id,
    canalNome: l.canais?.nome ?? null,
    campanhaId: l.campanha_id,
    criadaEm: l.criada_em,
    lidaEm: l.lida_em,
  };
}

/**
 * Caixa de avisos de cada perfil.
 *
 * TODA consulta é filtrada por `usuario.id`, nunca por um `perfilId` vindo do
 * cliente. A API usa a service role e ignora RLS — aqui não existe segunda
 * linha de defesa, então este filtro É a defesa.
 *
 * O fan-out (quem recebe o quê) já foi resolvido na escrita, pelo trigger
 * `notificar_envolvidos`. Repetir a regra de permissão aqui seria manter duas
 * cópias dela, que fatalmente divergiriam.
 */
@Injectable()
export class AvisosService {
  private readonly logger = new Logger(AvisosService.name);

  constructor(private readonly supabase: SupabaseService) {}

  async listar(usuario: UsuarioAutenticado, incluirLidos = false): Promise<Aviso[]> {
    let consulta = this.supabase
      .tabela("notificacoes")
      .select(COLUNAS_AVISO)
      .eq("perfil_id", usuario.id)
      .is("arquivada_em", null)
      .order("criada_em", { ascending: false })
      .limit(100);

    if (!incluirLidos) consulta = consulta.is("lida_em", null);

    const { data, error } = await consulta;
    if (error) throw new Error(`Falha ao listar avisos: ${error.message}`);
    return ((data ?? []) as unknown as LinhaAviso[]).map(paraAviso);
  }

  /** Só o número do sininho — o payload completo seria desperdício. */
  async contarNaoLidos(usuario: UsuarioAutenticado): Promise<{ total: number }> {
    const { count, error } = await this.supabase
      .tabela("notificacoes")
      .select("id", { count: "exact", head: true })
      .eq("perfil_id", usuario.id)
      .is("lida_em", null)
      .is("arquivada_em", null);

    if (error) throw new Error(`Falha ao contar avisos: ${error.message}`);
    return { total: count ?? 0 };
  }

  async marcarLido(usuario: UsuarioAutenticado, id: number): Promise<void> {
    // O `eq('perfil_id')` no UPDATE é o que impede marcar como lido o aviso de
    // outra pessoa passando um id qualquer.
    const { error } = await this.supabase
      .tabela("notificacoes")
      .update({ lida_em: new Date().toISOString() })
      .eq("id", id)
      .eq("perfil_id", usuario.id)
      .is("lida_em", null);

    if (error) throw new Error(`Falha ao marcar aviso como lido: ${error.message}`);
  }

  async marcarTodosLidos(usuario: UsuarioAutenticado): Promise<void> {
    const { error } = await this.supabase
      .tabela("notificacoes")
      .update({ lida_em: new Date().toISOString() })
      .eq("perfil_id", usuario.id)
      .is("lida_em", null)
      .is("arquivada_em", null);

    if (error) throw new Error(`Falha ao marcar avisos como lidos: ${error.message}`);
  }

  async arquivar(usuario: UsuarioAutenticado, id: number): Promise<void> {
    const agora = new Date().toISOString();
    const { error } = await this.supabase
      .tabela("notificacoes")
      // Arquivar implica lido: some da caixa, não pode continuar contando.
      .update({ arquivada_em: agora, lida_em: agora })
      .eq("id", id)
      .eq("perfil_id", usuario.id);

    if (error) throw new Error(`Falha ao arquivar aviso: ${error.message}`);
  }

  /**
   * Incidentes abertos que este usuário pode ver.
   *
   * Derivado das notificações dele em vez de consultar `incidentes` direto: a
   * permissão já foi decidida no fan-out, e refazer o join com `canal_membros`
   * aqui seria a segunda cópia da mesma regra.
   */
  async incidentesAbertos(usuario: UsuarioAutenticado): Promise<Incidente[]> {
    const { data, error } = await this.supabase
      .tabela("notificacoes")
      .select(
        "incidente_id, incidentes(id, categoria, codigo, canal_id, campanha_id, titulo, " +
          "detalhe, ocorrencias, aberto_em, resolvido_em, canais(nome))",
      )
      .eq("perfil_id", usuario.id)
      .eq("tipo", "abertura")
      .not("incidente_id", "is", null);

    if (error) throw new Error(`Falha ao listar incidentes: ${error.message}`);

    const linhas = ((data ?? []) as unknown as {
      incidentes: {
        id: number;
        categoria: CategoriaFalha;
        codigo: string;
        canal_id: string | null;
        campanha_id: string | null;
        titulo: string;
        detalhe: string | null;
        ocorrencias: number;
        aberto_em: string;
        resolvido_em: string | null;
        canais: { nome: string } | null;
      } | null;
    }[])
      .map((l) => l.incidentes)
      .filter((i): i is NonNullable<typeof i> => i !== null && i.resolvido_em === null);

    return linhas.map((i) => ({
      id: i.id,
      categoria: i.categoria,
      codigo: i.codigo,
      canalId: i.canal_id,
      canalNome: i.canais?.nome ?? null,
      campanhaId: i.campanha_id,
      titulo: i.titulo,
      detalhe: i.detalhe,
      ocorrencias: i.ocorrencias,
      abertoEm: i.aberto_em,
      resolvidoEm: i.resolvido_em,
    }));
  }
}
