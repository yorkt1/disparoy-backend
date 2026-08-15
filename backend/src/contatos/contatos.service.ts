import { Injectable } from "@nestjs/common";
import { normalizarTelefone } from "@disparoy/dominio";
import { SupabaseService } from "../supabase/supabase.service";
import { AuditoriaService } from "../auditoria/auditoria.service";
import type { UsuarioAutenticado } from "../auth/auth.guard";

/**
 * O que restou de "contatos": o pedido de saída.
 *
 * O cadastro deixou de existir — listar, importar, vincular a listas e excluir
 * saíram junto com ele, porque o público agora nasce e morre dentro da
 * campanha. O opt-out não podia ir junto: é obrigação legal, o pedido chega
 * pelo WhatsApp a qualquer momento, e precisa sobreviver a todas as campanhas.
 *
 * Por isso ele mora em `opt_outs`, indexado por telefone e empresa, sem
 * depender de nenhum contato salvo.
 */
@Injectable()
export class ContatosService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /**
   * Registra a saída e tira o número das campanhas ainda não enviadas.
   *
   * `usuario` nulo é o webhook: o pedido chegou por WhatsApp. Nesse caso a
   * empresa vai nula para a função, que trata isso como TODAS — entre marcar
   * demais e marcar de menos, só o segundo é violação.
   */
  async registrarOptOut(
    usuario: UsuarioAutenticado | null,
    telefone: string,
    motivo: string,
    ip?: string,
  ): Promise<boolean> {
    const normalizado = normalizarTelefone(telefone);
    if (!normalizado.valido) return false;

    const { data, error } = await this.supabase.db.rpc("registrar_opt_out", {
      p_telefone: normalizado.e164,
      p_motivo: motivo,
      p_empresa_id: usuario?.empresaId ?? null,
    });
    if (error) throw new Error(`Falha ao registrar opt-out: ${error.message}`);

    // A função devolve quantas linhas criou; zero é "já estava fora".
    if (!data || Number(data) === 0) return false;

    await this.auditoria.registrar({
      usuarioId: usuario?.id ?? null,
      usuarioNome: usuario?.nome ?? "Sistema",
      acao: "contato.opt_out",
      tipoEntidade: "contato",
      // Sem id: o opt-out é do TELEFONE, e o mesmo número pode ter saído de
      // mais de uma empresa na mesma chamada.
      entidadeId: null,
      entidadeRotulo: normalizado.e164,
      ip,
      detalhes: { motivo, empresasMarcadas: Number(data) },
    });

    return true;
  }
}
