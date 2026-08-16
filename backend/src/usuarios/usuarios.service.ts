import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { z } from "zod";
import type { AcaoLog, Usuario } from "@disparoy/dominio";
import type { ajusteUsuarioSchema, novoUsuarioSchema } from "@disparoy/dominio";
import { SupabaseService } from "../supabase/supabase.service";
import { AuditoriaService } from "../auditoria/auditoria.service";
import { COLUNAS_PERFIL, paraUsuario, type LinhaPerfil } from "../comum/mapeadores";
import type { UsuarioAutenticado } from "../auth/auth.guard";
import { gerarHash } from "../auth/senha";
import { noEscopo } from "../comum/escopo";

@Injectable()
export class UsuariosService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /**
   * Acessos que o autor pode ver.
   *
   * A conta global vê todos, inclusive os de outras empresas — é ela quem os
   * criou. Um admin de empresa vê só a própria gente.
   */
  async listar(autor: UsuarioAutenticado): Promise<Usuario[]> {
    const { data, error } = await noEscopo(
      this.supabase.tabela("perfis").select(COLUNAS_PERFIL),
      autor,
    ).order("criado_em");

    if (error) throw new Error(`Falha ao listar usuários: ${error.message}`);
    return (data as unknown as LinhaPerfil[]).map(paraUsuario);
  }

  /**
   * Cria um login com senha já definida pelo admin.
   *
   * Sistema interno: não existe auto-cadastro nem convite por e-mail. O perfil
   * é uma linha em `perfis`, com a senha guardada como hash scrypt.
   *
   * A senha entra aqui e não sai: não vai para o retorno nem para a auditoria,
   * e `COLUNAS_PERFIL` não inclui `senha_hash`, então nenhum endpoint a expõe
   * por descuido.
   */
  async criar(
    autor: UsuarioAutenticado,
    dados: z.infer<typeof novoUsuarioSchema>,
    ip: string,
  ): Promise<Usuario> {
    const email = dados.email.trim().toLowerCase();

    /*
     * A qual empresa o novo acesso pertence.
     *
     * A conta de administração é global e escolhe: é ela que cria o login de
     * cada empresa cliente. Um admin DE UMA empresa só cria gente na própria —
     * aceitar `empresaId` dele seria deixá-lo plantar um acesso dentro de
     * outra empresa.
     *
     * `null` só é possível pela conta global, e cria outra conta global: é
     * assim que se faz um segundo administrador de sistema.
     */
    const empresaId = autor.empresaId === null ? (dados.empresaId ?? null) : autor.empresaId;

    if (empresaId !== null) {
      const { data: existe } = await this.supabase
        .tabela("empresas")
        .select("id")
        .eq("id", empresaId)
        .maybeSingle();
      if (!existe) throw new BadRequestException("Empresa não encontrada.");
    }

    const { data, error } = await this.supabase
      .tabela("perfis")
      .insert({
        nome: dados.nome,
        email,
        papel: dados.papel,
        ativo: true,
        senha_hash: await gerarHash(dados.senha),
        criado_por: autor.id,
        empresa_id: empresaId,
      })
      .select("id")
      .single();

    if (error) {
      // 23505 = unique_violation, o índice de e-mail único em `perfis`.
      if (error.code === "23505") {
        throw new ConflictException("Já existe um usuário com esse e-mail.");
      }
      throw new BadRequestException(`Não foi possível criar o acesso: ${error.message}`);
    }

    const id = (data as { id: string }).id;

    await this.auditoria.registrar({
      usuarioId: autor.id,
      usuarioNome: autor.nome,
      acao: "usuario.criado",
      tipoEntidade: "usuario",
      entidadeId: id,
      entidadeRotulo: `${dados.nome} <${dados.email}>`,
      ip,
      detalhes: { papel: dados.papel, empresaId: empresaId ?? "global" },
    });

    return this.obter(id);
  }

  async ajustar(
    autor: UsuarioAutenticado,
    id: string,
    dados: z.infer<typeof ajusteUsuarioSchema>,
    ip: string,
  ): Promise<Usuario> {
    const alvo = await this.obter(id);

    // Um admin não pode se rebaixar nem se desativar: ficaria trancado para
    // fora da própria conta, e o sistema poderia acabar sem nenhum admin.
    if (autor.id === id && (dados.papel === "operator" || dados.ativo === false)) {
      throw new BadRequestException("Você não pode remover o próprio acesso de administrador.");
    }

    if (alvo.papel === "admin" && (dados.papel === "operator" || dados.ativo === false)) {
      await this.exigirOutroAdminAtivo(id);
    }

    // Sem e-mail de recuperação, é por aqui que alguém que esqueceu a senha
    // volta a entrar.
    const atualizacao: Record<string, unknown> = {};
    if (dados.papel !== undefined) atualizacao.papel = dados.papel;
    if (dados.ativo !== undefined) atualizacao.ativo = dados.ativo;
    if (dados.senha !== undefined) atualizacao.senha_hash = await gerarHash(dados.senha);

    if (Object.keys(atualizacao).length > 0) {
      const { error } = await this.supabase.tabela("perfis").update(atualizacao).eq("id", id);
      if (error) throw new Error(`Falha ao atualizar usuário: ${error.message}`);
    }

    // `detalhes` é montado campo a campo de propósito: espalhar `dados` gravaria
    // a senha em claro na trilha de auditoria, que é justamente o lugar mais
    // consultado do sistema.
    await this.auditoria.registrar({
      usuarioId: autor.id,
      usuarioNome: autor.nome,
      acao: acaoDoAjuste(dados),
      tipoEntidade: "usuario",
      entidadeId: id,
      entidadeRotulo: `${alvo.nome} <${alvo.email}>`,
      ip,
      detalhes: {
        ...(dados.papel !== undefined ? { papel: dados.papel } : {}),
        ...(dados.ativo !== undefined ? { ativo: dados.ativo } : {}),
        ...(dados.senha !== undefined ? { senhaRedefinida: true } : {}),
      },
    });

    return this.obter(id);
  }

  async obter(id: string): Promise<Usuario> {
    const { data, error } = await this.supabase
      .tabela("perfis")
      .select(COLUNAS_PERFIL)
      .eq("id", id)
      .maybeSingle();

    if (error) throw new Error(`Falha ao carregar usuário: ${error.message}`);
    if (!data) throw new NotFoundException("Usuário não encontrado.");
    return paraUsuario(data as unknown as LinhaPerfil);
  }

  /** Impede a instalação ficar sem nenhum administrador ativo. */
  private async exigirOutroAdminAtivo(excetoId: string): Promise<void> {
    const { count } = await this.supabase
      .tabela("perfis")
      .select("id", { count: "exact", head: true })
      .eq("papel", "admin")
      .eq("ativo", true)
      .neq("id", excetoId);

    if ((count ?? 0) === 0) {
      throw new BadRequestException(
        "Este é o último administrador ativo. Promova outro usuário antes.",
      );
    }
  }
}

/** Rótulo da ação na auditoria, do efeito mais grave para o mais brando. */
function acaoDoAjuste(dados: z.infer<typeof ajusteUsuarioSchema>): AcaoLog {
  if (dados.ativo === false) return "usuario.desativado";
  if (dados.papel !== undefined) return "usuario.papel_alterado";
  if (dados.senha !== undefined) return "usuario.senha_redefinida";
  return "usuario.reativado";
}
