import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { jwtVerify } from "jose";
import type { Request } from "express";
import type { Papel } from "@disparoy/dominio";
import { segredoJwt } from "../config/ambiente";
import { SupabaseService } from "../supabase/supabase.service";
import { ROTA_PUBLICA } from "./publico.decorator";
import { PAPEIS_EXIGIDOS } from "./papel.decorator";

export interface UsuarioAutenticado {
  id: string;
  email: string;
  nome: string;
  papel: Papel;
  /**
   * Empresa dona do dado que este login enxerga.
   *
   * `null` é acesso global — a conta de administração, que atravessa todas as
   * empresas. Quem consulta precisa tratar o `null` como "vê tudo"; tratá-lo
   * como "empresa nenhuma" faria o admin não ver nada, e tratá-lo por engano
   * como um valor comparável faria `.eq("empresa_id", null)` não casar com
   * linha alguma — dois jeitos silenciosos de errar, por isso o tipo é
   * explicitamente anulável.
   */
  empresaId: string | null;
}

declare module "express" {
  interface Request {
    usuario?: UsuarioAutenticado;
  }
}

/**
 * Valida o JWT emitido por esta API e resolve o perfil.
 *
 * O PAPEL nunca vem do token nem do corpo da requisição — é lido do banco a
 * cada request. O token diz apenas QUEM é (`sub`); o que essa pessoa pode
 * fazer sai de `perfis`, então promover ou rebaixar alguém vale na hora.
 *
 * Perfil desativado é barrado aqui: desativar um login precisa cortar o acesso
 * imediatamente, sem depender de o token expirar.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  /** Cache curto: evita um SELECT por request sem segurar mudança de papel. */
  private readonly cachePerfil = new Map<string, { valor: UsuarioAutenticado; expiraEm: number }>();
  private static readonly TTL_CACHE_MS = 15_000;

  constructor(
    private readonly reflector: Reflector,
    private readonly supabase: SupabaseService,
  ) {}

  async canActivate(contexto: ExecutionContext): Promise<boolean> {
    const alvos = [contexto.getHandler(), contexto.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(ROTA_PUBLICA, alvos)) return true;

    const req = contexto.switchToHttp().getRequest<Request>();
    const token = extrairToken(req);
    if (!token) throw new UnauthorizedException("Token de acesso ausente.");

    const { sub } = await this.validarToken(token);
    const usuario = await this.resolverPerfil(sub);
    req.usuario = usuario;

    const exigidos = this.reflector.getAllAndOverride<Papel[]>(PAPEIS_EXIGIDOS, alvos);
    if (exigidos?.length && !exigidos.includes(usuario.papel)) {
      throw new ForbiddenException("Esta ação é restrita a administradores.");
    }

    return true;
  }

  /**
   * Verifica a assinatura localmente — sem rede, sem chamada externa.
   *
   * `algorithms` fixo em HS256 de propósito: sem essa trava, um token com
   * `alg: none` no cabeçalho seria aceito como válido.
   */
  private async validarToken(token: string): Promise<{ sub: string }> {
    try {
      const { payload } = await jwtVerify(token, segredoJwt(), {
        algorithms: ["HS256"],
        issuer: "disparoy",
      });
      const sub = String(payload.sub ?? "");
      if (!sub) throw new Error("sub ausente");
      return { sub };
    } catch {
      throw new UnauthorizedException("Sessão inválida ou expirada.");
    }
  }

  private async resolverPerfil(id: string): Promise<UsuarioAutenticado> {
    const agora = Date.now();
    const cacheado = this.cachePerfil.get(id);
    if (cacheado && cacheado.expiraEm > agora) return cacheado.valor;

    const { data, error } = await this.supabase
      .tabela("perfis")
      .select("id, nome, email, papel, ativo, empresa_id")
      .eq("id", id)
      .maybeSingle();

    if (error) throw new UnauthorizedException("Não foi possível carregar o perfil.");
    if (!data) {
      // Token válido para um perfil que não existe mais: excluído depois de
      // emitido. O token continua assinado, o acesso não.
      throw new UnauthorizedException("Perfil não encontrado.");
    }
    if (!data.ativo) {
      throw new ForbiddenException("Este acesso foi desativado.");
    }

    const usuario: UsuarioAutenticado = {
      id: data.id,
      email: data.email,
      nome: data.nome,
      papel: data.papel as Papel,
      // `?? null` e não `?? undefined`: a coluna é nova e um perfil gravado
      // antes dela vem sem a chave. Sem o coalesce, `empresaId` chegaria
      // `undefined` nos serviços e um filtro condicional o leria como "sem
      // empresa" em vez de "acesso global".
      empresaId: (data.empresa_id as string | null) ?? null,
    };

    this.cachePerfil.set(id, { valor: usuario, expiraEm: agora + AuthGuard.TTL_CACHE_MS });
    return usuario;
  }

  /** Chamado quando um perfil muda de papel ou é desativado. */
  invalidar(perfilId: string): void {
    this.cachePerfil.delete(perfilId);
  }
}

function extrairToken(req: Request): string | null {
  const cabecalho = req.headers.authorization;
  if (!cabecalho?.startsWith("Bearer ")) return null;
  return cabecalho.slice(7).trim() || null;
}
