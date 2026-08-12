import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { z } from "zod";
import type { Canal, MembroCanal } from "@disparoy/dominio";
import { canalAjusteSchema, canalEntradaSchema, formatarTelefone, limiteSugerido } from "@disparoy/dominio";
import { SupabaseService } from "../supabase/supabase.service";
import { AuditoriaService } from "../auditoria/auditoria.service";
import { WhatsappService } from "../whatsapp/whatsapp.service";
import { excluirInstancia } from "../whatsapp/evolution-provider";
import { COLUNAS_CANAL, paraCanal, type LinhaCanal } from "../comum/mapeadores";
import type { UsuarioAutenticado } from "../auth/auth.guard";

/** Nome legível no painel da Evolution: minúsculas, sem acento, com hífen. */
function apelidar(nome: string): string {
  const limpo = nome
    .normalize("NFD")
    // \p{Diacritic} em vez do intervalo \u0300-\u036f: o intervalo exige
    // marcas combinantes literais no fonte, que são invisíveis no editor.
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  // Nome só de emoji ou de pontuação sobraria vazio e geraria `disparoy__abc`.
  return limpo || "canal";
}

function sufixoAleatorio(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** Nome do canal, com o número quando ele já é conhecido. */
function rotular(canal: Canal): string {
  return canal.numero ? `${canal.nome} (${formatarTelefone(canal.numero)})` : canal.nome;
}

@Injectable()
export class CanaisService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly auditoria: AuditoriaService,
    private readonly whatsapp: WhatsappService,
  ) {}

  /**
   * Canais que o usuário pode operar.
   *
   * Admin vê todos; operador vê apenas aqueles em que foi vinculado. O filtro
   * acontece aqui e não no RLS porque a API usa a service role, que o ignora.
   */
  async listar(usuario: UsuarioAutenticado): Promise<Canal[]> {
    if (usuario.papel === "admin") {
      const { data, error } = await this.supabase
        .tabela("canais")
        .select(COLUNAS_CANAL)
        .order("nome");
      if (error) throw new Error(`Falha ao listar canais: ${error.message}`);
      return (data as unknown as LinhaCanal[]).map(paraCanal);
    }

    const { data, error } = await this.supabase
      .tabela("canal_membros")
      .select(`canais(${COLUNAS_CANAL})`)
      .eq("perfil_id", usuario.id);

    if (error) throw new Error(`Falha ao listar canais: ${error.message}`);
    return ((data ?? []) as unknown as { canais: LinhaCanal | null }[])
      .map((l) => l.canais)
      .filter((c): c is LinhaCanal => c !== null)
      .map(paraCanal)
      .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  }

  async obter(usuario: UsuarioAutenticado, id: string): Promise<Canal> {
    const { data, error } = await this.supabase
      .tabela("canais")
      .select(COLUNAS_CANAL)
      .eq("id", id)
      .maybeSingle();

    if (error) throw new Error(`Falha ao carregar canal: ${error.message}`);
    if (!data) throw new NotFoundException("Canal não encontrado.");

    await this.exigirAcesso(usuario, id);
    return paraCanal(data as unknown as LinhaCanal);
  }

  /** Operador sem vínculo não enxerga nem opera o canal. */
  async exigirAcesso(usuario: UsuarioAutenticado, canalId: string): Promise<void> {
    if (usuario.papel === "admin") return;

    const { data } = await this.supabase
      .tabela("canal_membros")
      .select("permissao")
      .eq("canal_id", canalId)
      .eq("perfil_id", usuario.id)
      .maybeSingle();

    if (!data) throw new ForbiddenException("Você não tem acesso a este canal.");
  }

  /**
   * Cria o canal e abre a sessão na Evolution.
   *
   * Pede só o nome: o número chega pelo webhook quando alguém escaneia o QR.
   *
   * Nasce `aguardando_qr` e só vira `conectado` quando o webhook
   * CONNECTION_UPDATE confirma o pareamento — senão a listagem mentiria sobre
   * o que está pronto para disparar.
   */
  async criar(
    usuario: UsuarioAutenticado,
    dados: z.infer<typeof canalEntradaSchema>,
    ip: string,
  ): Promise<{ canal: Canal; qr: string | null; expiraEm: string | null; aviso?: string }> {
    // O nome da instância não pode mais sair do número, que ainda não existe.
    // Vem do nome mais um sufixo aleatório: o prefixo `disparoy_` separa das
    // instâncias de outros sistemas no mesmo servidor Evolution, e o sufixo
    // deixa dois canais com o mesmo nome conviverem.
    const instancia = `disparoy_${apelidar(dados.nome)}_${sufixoAleatorio()}`;

    const { data, error } = await this.supabase
      .tabela("canais")
      .insert({
        nome: dados.nome,
        numero: null,
        instancia_evolution: instancia,
        tipo_conexao: "qrcode",
        status: "aguardando_qr",
        limite_diario: dados.limiteDiario || limiteSugerido(dados.estagioAquecimento),
        estagio_aquecimento: dados.estagioAquecimento,
        criado_por: usuario.id,
      })
      .select(COLUNAS_CANAL)
      .single();

    // 23505 = unique_violation em `instancia_evolution`. Com o sufixo aleatório
    // isso é colisão de sorteio: tentar de novo resolve.
    if (error?.code === "23505") {
      throw new ConflictException("Conflito ao nomear a instância. Tente novamente.");
    }
    if (error) throw new Error(`Falha ao criar canal: ${error.message}`);

    const canal = paraCanal(data as unknown as LinhaCanal);

    // Quem cria vira dono; sem isto o próprio autor perderia acesso ao canal.
    await this.supabase
      .tabela("canal_membros")
      .insert({ canal_id: canal.id, perfil_id: usuario.id, permissao: "owner" });

    await this.auditoria.registrar({
      usuarioId: usuario.id,
      usuarioNome: usuario.nome,
      acao: "canal.onboarding",
      tipoEntidade: "canal",
      entidadeId: canal.id,
      // Sem número ainda: o rótulo é o nome, e o número aparece na auditoria
      // do `canal.conectado`, quando o pareamento revelar qual é.
      entidadeRotulo: canal.nome,
      ip,
      detalhes: { instancia },
    });

    try {
      const sessao = await this.whatsapp.iniciarSessaoQr(canal);
      return { canal, qr: sessao.qr, expiraEm: sessao.expiraEm };
    } catch (e) {
      // O canal já existe no banco; a falha é só do pareamento. Devolver o
      // canal com o aviso deixa o operador tentar de novo pela listagem.
      return {
        canal,
        qr: null,
        expiraEm: null,
        aviso: e instanceof Error ? e.message : "Não foi possível gerar o QR Code.",
      };
    }
  }

  /** Gera um QR novo para um canal já cadastrado (o anterior expira em ~1 min). */
  async reconectar(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<{ qr: string; expiraEm: string }> {
    const canal = await this.obter(usuario, id);
    if (canal.tipoConexao !== "qrcode") {
      throw new BadRequestException("Canais de API Oficial não pareiam por QR Code.");
    }
    const sessao = await this.whatsapp.iniciarSessaoQr(canal);
    return { qr: sessao.qr, expiraEm: sessao.expiraEm };
  }

  async ajustar(
    usuario: UsuarioAutenticado,
    id: string,
    dados: z.infer<typeof canalAjusteSchema>,
    ip: string,
  ): Promise<Canal> {
    const canal = await this.obter(usuario, id);

    // Encerra a sessão ANTES de mudar o estado local, senão o número seguiria
    // pareado na Evolution enquanto aparece como desconectado aqui.
    if (dados.status === "desconectado" && canal.tipoConexao === "qrcode") {
      await this.whatsapp.encerrarSessaoQr(canal).catch(() => undefined);
    }

    const atualizacao: Record<string, unknown> = {};
    if (dados.limiteDiario !== undefined) atualizacao.limite_diario = dados.limiteDiario;
    if (dados.estagioAquecimento !== undefined) {
      atualizacao.estagio_aquecimento = dados.estagioAquecimento;
      // Subir o estágio sem subir o teto não muda nada na prática.
      if (dados.limiteDiario === undefined) {
        atualizacao.limite_diario = limiteSugerido(dados.estagioAquecimento);
      }
    }
    if (dados.status !== undefined) atualizacao.status = dados.status;
    if (Object.keys(atualizacao).length === 0) return canal;

    const { data, error } = await this.supabase
      .tabela("canais")
      .update(atualizacao)
      .eq("id", id)
      .select(COLUNAS_CANAL)
      .single();

    if (error) throw new Error(`Falha ao atualizar canal: ${error.message}`);

    if (dados.status) {
      await this.auditoria.registrar({
        usuarioId: usuario.id,
        usuarioNome: usuario.nome,
        acao: dados.status === "conectado" ? "canal.conectado" : "canal.desconectado",
        tipoEntidade: "canal",
        entidadeId: id,
        entidadeRotulo: rotular(canal),
        ip,
        detalhes: { motivo: "ação do operador" },
      });
    }

    return paraCanal(data as unknown as LinhaCanal);
  }

  async excluir(usuario: UsuarioAutenticado, id: string, ip: string): Promise<void> {
    const canal = await this.obter(usuario, id);

    const { error } = await this.supabase.tabela("canais").delete().eq("id", id);

    // 23503: campanha_canais referencia o canal com ON DELETE RESTRICT, para
    // não apagar o histórico de quem já disparou por ele.
    if (error?.code === "23503") {
      throw new ConflictException(
        "Esse canal já foi usado em campanhas. Desconecte-o em vez de excluir.",
      );
    }
    if (error) throw new Error(`Falha ao excluir canal: ${error.message}`);

    await excluirInstancia(canal.instanciaEvolution);

    await this.auditoria.registrar({
      usuarioId: usuario.id,
      usuarioNome: usuario.nome,
      acao: "canal.excluido",
      tipoEntidade: "canal",
      entidadeId: id,
      entidadeRotulo: rotular(canal),
      ip,
    });
  }

  // ------------------------------------------------------------------------
  // Compartilhamento
  // ------------------------------------------------------------------------

  async listarMembros(usuario: UsuarioAutenticado, canalId: string): Promise<MembroCanal[]> {
    await this.exigirAcesso(usuario, canalId);

    const { data, error } = await this.supabase
      .tabela("canal_membros")
      .select("canal_id, perfil_id, permissao, perfis(nome)")
      .eq("canal_id", canalId);

    if (error) throw new Error(`Falha ao listar membros: ${error.message}`);

    return ((data ?? []) as unknown as {
      canal_id: string;
      perfil_id: string;
      permissao: MembroCanal["permissao"];
      perfis: { nome: string } | null;
    }[]).map((l) => ({
      canalId: l.canal_id,
      perfilId: l.perfil_id,
      nome: l.perfis?.nome ?? "—",
      permissao: l.permissao,
    }));
  }

  async definirMembro(
    usuario: UsuarioAutenticado,
    canalId: string,
    perfilId: string,
    permissao: MembroCanal["permissao"],
  ): Promise<void> {
    await this.exigirAcesso(usuario, canalId);
    const { error } = await this.supabase
      .tabela("canal_membros")
      .upsert(
        { canal_id: canalId, perfil_id: perfilId, permissao },
        { onConflict: "canal_id,perfil_id" },
      );
    if (error) throw new Error(`Falha ao vincular operador: ${error.message}`);
  }

  async removerMembro(
    usuario: UsuarioAutenticado,
    canalId: string,
    perfilId: string,
  ): Promise<void> {
    await this.exigirAcesso(usuario, canalId);
    const { error } = await this.supabase
      .tabela("canal_membros")
      .delete()
      .eq("canal_id", canalId)
      .eq("perfil_id", perfilId);
    if (error) throw new Error(`Falha ao remover operador: ${error.message}`);
  }
}
