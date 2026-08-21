import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { SignJWT } from "jose";
import type { Papel, Usuario } from "@disparoy/dominio";
import { SupabaseService } from "../supabase/supabase.service";
import { AuditoriaService } from "../auditoria/auditoria.service";
import { FreioService } from "../comum/freio.service";
import { ambiente, segredoJwt } from "../config/ambiente";
import { COLUNAS_PERFIL, paraUsuario, type LinhaPerfil } from "../comum/mapeadores";
import { conferirSenha, gerarHash, motivoSenhaFraca } from "./senha";
import type { UsuarioAutenticado } from "./auth.guard";

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
    private readonly freio: FreioService,
  ) {}

  async entrar(email: string, senha: string, ip: string): Promise<SessaoCriada> {
    const alvo = email.trim().toLowerCase();

    /**
     * A conta trancada é recusada antes de qualquer consulta.
     *
     * O teto por IP do `sessao.controller.ts` não cobre o ataque que importa
     * aqui: uma lista de senhas comuns disparada contra UMA conta, a partir de
     * muitos IPs, nunca estoura o limite de nenhum deles. Este freio conta por
     * CONTA, e é o que transforma "senha fraca de operador" em algo que leva
     * meses em vez de minutos.
     *
     * Dizer que está bloqueado — em vez de repetir "e-mail ou senha inválidos"
     * — não entrega quais e-mails existem: `chaveDeLogin` conta o endereço
     * TENTADO, cadastrado ou não, então um e-mail inexistente tranca igual. E
     * quem está só errando a própria senha precisa entender por que parou de
     * funcionar, senão vira chamado.
     */
    const bloqueadoPor = await this.freio.loginBloqueadoPor(alvo);
    if (bloqueadoPor > 0) {
      const minutos = Math.max(1, Math.ceil(bloqueadoPor / 60));
      throw new HttpException(
        `Tentativas demais nesta conta. Tente de novo em ${minutos} ` +
          `${minutos === 1 ? "minuto" : "minutos"}.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const { data, error } = await this.supabase
      .tabela("perfis")
      .select(`${COLUNAS_PERFIL}, senha_hash`)
      .eq("email", alvo)
      .maybeSingle();

    if (error) throw new Error(`Falha ao consultar o perfil: ${error.message}`);

    const linha = data as (LinhaPerfil & { senha_hash: string | null }) | null;

    // A senha é conferida ANTES de olhar `linha` e ANTES de olhar `ativo`, e
    // `conferirSenha` deriva scrypt mesmo recebendo `null` — é o que faz os
    // três caminhos de recusa custarem o mesmo. Sair mais cedo em qualquer um
    // deles devolveria a resposta em microssegundos contra os ~100 ms de um
    // e-mail cadastrado, e o login viraria um oráculo de quais endereços estão
    // na base, sem precisar acertar senha nenhuma.
    const confere = await conferirSenha(senha, linha?.senha_hash ?? null);

    // Mensagem única para e-mail errado, senha errada e perfil desativado.
    // Detalhar qual dos três falhou entrega meio login para quem está tentando.
    if (!linha || !confere || !linha.ativo) {
      // Conta a tentativa DEPOIS de recusar, e para os três casos: contar só o
      // e-mail existente faria a conta trancar apenas quando o endereço está na
      // base, e a diferença entre trancar e não trancar viraria o oráculo de
      // existência que a mensagem única evita.
      await this.freio.registrarFalhaDeLogin(alvo);
      throw new UnauthorizedException("E-mail ou senha inválidos.");
    }

    // Acertou: o histórico de falhas some. Sem isto, nove erros de digitação
    // espalhados pela semana deixariam a conta a uma tentativa de trancar.
    await this.freio.limparFalhasDeLogin(alvo);

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
   * Troca a própria senha, conferindo a atual.
   *
   * Existe porque sem ela ninguém sai do lugar: quem quisesse trocar a senha
   * dependia de um admin, e o admin que esquecesse a dele ficava trancado do
   * lado de fora do sistema — `ADMIN_SENHA` no `.env` é ignorado quando a conta
   * já existe, então não havia caminho nenhum pelo produto.
   *
   * A senha ATUAL é exigida mesmo com a sessão já autenticada. O token vive 12
   * horas e mora no `localStorage`: quem senta na máquina destravada de alguém,
   * ou rouba o token por XSS, não pode trocar a senha e tomar a conta de vez.
   *
   * O que isto NÃO faz é derrubar as outras sessões. Os tokens são assinados e
   * sem estado — não há lista de sessões ativas para invalidar, e um token
   * emitido antes da troca continua valendo até expirar. Derrubar todo mundo
   * exigiria versionar o segredo por usuário; para uma ferramenta interna, o
   * caminho existente é o admin desativar o acesso, que corta na hora.
   */
  async trocarPropriaSenha(
    usuario: UsuarioAutenticado,
    senhaAtual: string,
    novaSenha: string,
    ip: string,
  ): Promise<void> {
    if (senhaAtual === novaSenha) {
      throw new BadRequestException("A nova senha precisa ser diferente da atual.");
    }

    const fraca = motivoSenhaFraca(novaSenha, { email: usuario.email, nome: usuario.nome });
    if (fraca) throw new BadRequestException(fraca);

    const { data, error } = await this.supabase
      .tabela("perfis")
      .select("senha_hash")
      .eq("id", usuario.id)
      .maybeSingle();

    if (error) throw new Error(`Falha ao consultar o perfil: ${error.message}`);

    const atual = (data as { senha_hash: string | null } | null)?.senha_hash ?? null;
    if (!(await conferirSenha(senhaAtual, atual))) {
      /**
       * 400, e não o 401 que a semântica pediria.
       *
       * Nesta API o 401 tem significado operacional: o cliente HTTP do painel
       * trata todo 401 como sessão morta e limpa o token, jogando a pessoa na
       * tela de login. Aqui a sessão está perfeitamente válida — quem está
       * errado é um campo do corpo. Devolver 401 expulsaria do painel quem só
       * digitou a senha antiga errado.
       *
       * A alternativa seria ensinar o cliente a distinguir os dois 401 por um
       * código na resposta. Não compensa: é um caso só, e um contrato a mais
       * para alguém quebrar depois.
       */
      throw new BadRequestException("A senha atual está incorreta.");
    }

    const { error: erroGravacao } = await this.supabase
      .tabela("perfis")
      .update({ senha_hash: await gerarHash(novaSenha) })
      .eq("id", usuario.id);

    if (erroGravacao) throw new Error(`Falha ao gravar a nova senha: ${erroGravacao.message}`);

    await this.auditoria.registrar({
      usuarioId: usuario.id,
      usuarioNome: usuario.nome,
      acao: "usuario.senha_alterada",
      tipoEntidade: "usuario",
      entidadeId: usuario.id,
      entidadeRotulo: `${usuario.nome} <${usuario.email}>`,
      ip,
      // Sem a senha, obviamente: a trilha de auditoria é o último lugar onde
      // uma credencial em claro deveria aparecer.
      detalhes: { porPropriaConta: true },
    });
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
