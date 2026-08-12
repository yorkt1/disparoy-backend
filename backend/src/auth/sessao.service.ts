import { Injectable, UnauthorizedException } from "@nestjs/common";
import { SignJWT } from "jose";
import type { Papel, Usuario } from "@disparoy/dominio";
import { SupabaseService } from "../supabase/supabase.service";
import { AuditoriaService } from "../auditoria/auditoria.service";
import { ambiente, segredoJwt } from "../config/ambiente";
import { COLUNAS_PERFIL, paraUsuario, type LinhaPerfil } from "../comum/mapeadores";
import { conferirSenha } from "./senha";

export interface SessaoCriada {
  token: string;
  expiraEm: string;
  usuario: Usuario;
}

/**
 * Login com e-mail e senha, verificados contra `perfis`.
 *
 * O token é assinado por esta API, com `JWT_SECRET`. Não há refresh token: numa
 * ferramenta interna, sessão longa e logout explícito resolvem, e cada request
 * relê o perfil no banco de qualquer forma — desativar alguém corta o acesso
 * sem esperar token nenhum expirar.
 */
@Injectable()
export class SessaoService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly auditoria: AuditoriaService,
  ) {}

  async entrar(email: string, senha: string, ip: string): Promise<SessaoCriada> {
    const alvo = email.trim().toLowerCase();

    const { data, error } = await this.supabase
      .tabela("perfis")
      .select(`${COLUNAS_PERFIL}, senha_hash`)
      .eq("email", alvo)
      .maybeSingle();

    if (error) throw new Error(`Falha ao consultar o perfil: ${error.message}`);

    const linha = data as (LinhaPerfil & { senha_hash: string | null }) | null;

    // A senha é conferida mesmo quando o e-mail não existe, contra um hash
    // descartável: responder na hora para e-mail inexistente revelaria, pelo
    // tempo, quais endereços estão cadastrados.
    const confere = await conferirSenha(senha, linha?.senha_hash ?? null);

    // Mensagem única para e-mail errado, senha errada e perfil desativado.
    // Detalhar qual dos três falhou entrega meio login para quem está tentando.
    if (!linha || !confere || !linha.ativo) {
      throw new UnauthorizedException("E-mail ou senha inválidos.");
    }

    const usuario = paraUsuario(linha);
    const { token, expiraEm } = await this.assinar(usuario.id, usuario.papel);

    await this.auditoria.registrar({
      usuarioId: usuario.id,
      usuarioNome: usuario.nome,
      acao: "sessao.iniciada",
      tipoEntidade: "usuario",
      entidadeId: usuario.id,
      entidadeRotulo: `${usuario.nome} <${usuario.email}>`,
      ip,
      detalhes: {},
    });

    return { token, expiraEm, usuario };
  }

  /**
   * O papel entra no token só como informação; quem manda é o banco.
   *
   * O `AuthGuard` relê `perfis` a cada request justamente para que promover ou
   * desativar alguém tenha efeito imediato, sem esperar o token virar.
   */
  private async assinar(id: string, papel: Papel): Promise<{ token: string; expiraEm: string }> {
    const horas = ambiente().SESSAO_HORAS;
    const expiraEm = new Date(Date.now() + horas * 3_600_000);

    const token = await new SignJWT({ papel })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(id)
      .setIssuedAt()
      .setIssuer("disparoy")
      .setExpirationTime(Math.floor(expiraEm.getTime() / 1000))
      .sign(segredoJwt());

    return { token, expiraEm: expiraEm.toISOString() };
  }
}
