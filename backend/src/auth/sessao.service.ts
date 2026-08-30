import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { SignJWT } from "jose";
import type { Papel, Usuario } from "@disparoy/dominio";
import { SupabaseService } from "../supabase/supabase.service";
import { AuditoriaService } from "../auditoria/auditoria.service";
import { FreioService } from "../comum/freio.service";
import { ambiente, segredoJwt } from "../config/ambiente";
import { COLUNAS_PERFIL, paraUsuario, type LinhaPerfil } from "../comum/mapeadores";
import { noEscopo } from "../comum/escopo";
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
  private async assinar(
    id: string,
    papel: Papel,
    /** Presente só na personificação; vai assinado dentro do token. */
    personificadoPor?: { id: string; nome: string },
  ): Promise<{ token: string; expiraEm: string }> {
    /*
     * A sessão personificada dura MENOS que a normal.
     *
     * `SESSAO_HORAS` é dimensionado para quem trabalha o dia dentro do painel.
     * Personificar é entrar, olhar o que o cliente está vendo e sair — e o
     * risco de esquecer uma aba aberta dentro da conta de um cliente por 12 h,
     * num navegador compartilhado, não se paga por nenhuma conveniência.
     */
    const horas = personificadoPor ? 1 : ambiente().SESSAO_HORAS;
    const expiraEm = new Date(Date.now() + horas * 3_600_000);

    const token = await new SignJWT({ papel, ...(personificadoPor ? { personificadoPor } : {}) })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(id)
      .setIssuedAt()
      .setIssuer("disparoy")
      .setExpirationTime(Math.floor(expiraEm.getTime() / 1000))
      .sign(segredoJwt());

    return { token, expiraEm: expiraEm.toISOString() };
  }

  /**
   * Entra no painel COMO outra pessoa, sem a senha dela.
   *
   * Existe para o suporte: descobrir por que o canal do cliente não conecta,
   * ou por que a campanha dele não saiu, sem pedir a senha por WhatsApp — que
   * é o que se faria sem isto, e que é bem pior do que esta rota.
   *
   * A sessão emitida é a do ALVO: mesmas permissões, mesma empresa, mesma
   * tela. O que ela carrega a mais é a marca de quem entrou, que o `AuthGuard`
   * usa para emendar "(via Fulano)" no nome — de modo que tudo que for feito
   * daqui para frente apareça na auditoria como o que é. Sem essa marca, esta
   * rota apagaria a diferença entre o cliente e o suporte, e a trilha deixaria
   * de responder a pergunta para a qual ela existe.
   */
  async personificar(
    autor: UsuarioAutenticado,
    alvoId: string,
    ip: string,
  ): Promise<SessaoCriada> {
    /*
     * Só a conta de administração, e o teste é por EMPRESA, não por papel.
     *
     * `papel === "admin"` não serve: cada empresa cliente tem o próprio admin,
     * e deixá-lo personificar seria dar a ele a conta de qualquer colega — e,
     * se o alvo fosse de outra empresa, a de um cliente concorrente.
     */
    if (autor.empresaId !== null) {
      throw new ForbiddenException("Apenas a conta de administração entra em outras contas.");
    }

    // Personificar quem já está personificando é como o rastro se perde: a
    // segunda marca sobrescreveria a primeira e o "via" apontaria para o
    // cliente, não para quem de fato começou.
    if (autor.personificadoPor) {
      throw new BadRequestException(
        "Você já está dentro de outra conta. Volte para a sua antes de entrar em outra.",
      );
    }

    if (autor.id === alvoId) {
      throw new BadRequestException("Você já está na sua própria conta.");
    }

    /*
     * `noEscopo` é um no-op para a conta global — que é a única que chega
     * aqui — e é justamente por isso que ele fica: atravessar as empresas é o
     * PONTO desta rota, e escrever isso explicitamente diz que a ausência de
     * filtro foi decidida, não esquecida. Se um dia a trava lá em cima
     * afrouxar, quem entrar já fica confinado à própria empresa em vez de
     * alcançar a conta de um cliente concorrente com um uuid da URL.
     */
    const { data, error } = await noEscopo(
      this.supabase.tabela("perfis").select(COLUNAS_PERFIL).eq("id", alvoId),
      autor,
    ).maybeSingle();

    if (error) throw new Error(`Falha ao consultar o perfil: ${error.message}`);
    if (!data) throw new NotFoundException("Acesso não encontrado.");

    const alvo = paraUsuario(data as unknown as LinhaPerfil);

    // Acesso desativado não entra pelo login; não pode entrar por aqui
    // tampouco, senão esta rota vira o jeito de contornar a desativação.
    if (!alvo.ativo) {
      throw new BadRequestException("Este acesso está desativado. Reative-o antes de entrar nele.");
    }

    /*
     * A auditoria é gravada com o autor REAL e antes de o token existir.
     *
     * É a única linha da trilha que nomeia quem entrou — as ações seguintes
     * saem no nome do cliente com "(via Fulano)" emendado. Se esta gravação
     * ficasse depois, uma falha entre as duas emitiria um token de suporte sem
     * registro nenhum de que ele foi emitido.
     */
    await this.auditoria.registrar({
      usuarioId: autor.id,
      usuarioNome: autor.nome,
      acao: "usuario.personificado",
      tipoEntidade: "usuario",
      entidadeId: alvo.id,
      entidadeRotulo: `${alvo.nome} <${alvo.email}>`,
      ip,
      detalhes: { papel: alvo.papel },
    });

    const { token, expiraEm } = await this.assinar(alvo.id, alvo.papel, {
      id: autor.id,
      nome: autor.nome,
    });

    return { token, expiraEm, usuario: alvo };
  }
}
