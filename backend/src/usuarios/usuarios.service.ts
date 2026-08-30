import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
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
     * A senha que o admin define para outra pessoa NÃO passa por
     * `motivoSenhaFraca`. Foi decisão do dono do produto, em 30/08/2026, para
     * poder entregar uma senha padrão curta e igual em todos os acessos.
     *
     * O que isso custa, para quem for reabrir: `senhaSchema` só mede
     * comprimento, e o mínimo dele é 6 — então `123456` é aceito e vira a senha
     * definitiva de um acesso que enxerga a base inteira de contatos de uma
     * empresa e dispara em nome do WhatsApp dela. Sendo a mesma senha em todas
     * as empresas, descobrir uma é entrar em todas, e o teto de tentativas do
     * login atrasa a força bruta sem impedi-la.
     *
     * `motivoSenhaFraca` continua existindo e continua valendo em
     * `sessao.service.trocarPropriaSenha`: quando a pessoa escolhe a PRÓPRIA
     * senha, há alguém do outro lado para escolher outra.
     */

    /*
     * Criar acesso é da conta de administração, e só dela.
     *
     * `@SomenteAdmin()` no controller não basta: cada empresa cliente tem o
     * próprio admin, e `papel === "admin"` não distingue o dono do sistema do
     * administrador de um cliente. Quem entrega login é quem cobra por ele.
     */
    if (autor.empresaId !== null) {
      throw new ForbiddenException(
        "Apenas a conta de administração cria acessos. Peça um login ao administrador do sistema.",
      );
    }

    /*
     * A empresa do novo acesso é OBRIGATÓRIA de vir no corpo, e a distinção
     * entre `undefined` e `null` é o ponto inteiro deste bloco.
     *
     * Antes, campo ausente virava `null` por um `??`, e `null` é acesso GLOBAL:
     * a tela de Usuários, que nunca mandou `empresaId`, criava clientes que
     * enxergavam canal, campanha e dashboard de todas as empresas. Ninguém
     * percebia, porque nada falhava — o acesso funcionava, só que vendo demais.
     *
     * Agora "esqueci de dizer a empresa" (`undefined`) é erro na primeira
     * tentativa, e só um `null` ESCRITO no corpo cria outra conta global, que
     * é como se faz um segundo administrador de sistema.
     */
    if (dados.empresaId === undefined) {
      throw new BadRequestException(
        "Informe a empresa deste acesso. Crie o login pela tela de Empresas.",
      );
    }
    const empresaId = dados.empresaId;

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
    /*
     * O alvo é carregado NO ESCOPO do autor, não por id solto.
     *
     * `obter(id)` não filtra por empresa, e esta rota é `@SomenteAdmin()` —
     * guard que o admin de CADA empresa também passa. Com o uuid de um perfil
     * de outra empresa, um admin redefinia a senha dele (`dados.senha` mais
     * abaixo), desativava ou promovia: tomada de conta entre clientes. Que a
     * listagem seja escopada e não mostre esse uuid é obscuridade, não
     * controle de acesso — o id chega pela URL.
     */
    const alvo = await this.obterNoEscopo(autor, id);

    // Um admin não pode se rebaixar nem se desativar: ficaria trancado para
    // fora da própria conta, e o sistema poderia acabar sem nenhum admin.
    if (autor.id === id && (dados.papel === "operator" || dados.ativo === false)) {
      throw new BadRequestException("Você não pode remover o próprio acesso de administrador.");
    }

    if (alvo.papel === "admin" && (dados.papel === "operator" || dados.ativo === false)) {
      await this.exigirOutroAdminAtivo(id);
    }

    if (dados.senha !== undefined) {
      /*
       * Redefinir a PRÓPRIA senha não passa por aqui.
       *
       * `trocarPropriaSenha` exige a senha atual de propósito, e o comentário
       * dela diz por quê: o token vive 12 h no `localStorage`, e quem senta na
       * máquina destravada de um admin — ou rouba o token por XSS — não pode
       * transformar acesso temporário em posse definitiva da conta. Esta rota
       * é `@SomenteAdmin()` e aceitava `:id` igual ao do autor, o que dava
       * exatamente esse atalho: mesmo efeito, sem conferir nada. Quem esqueceu
       * a própria senha continua tendo caminho — outro admin redefine, ou
       * `npm run redefinir-senha` no Shell do serviço.
       */
      if (autor.id === id) {
        throw new BadRequestException(
          "Para trocar a sua própria senha, use a tela de perfil — a senha atual é exigida.",
        );
      }

      // Sem verificação de senha fraca, pelo mesmo motivo registrado em
      // `criar`: a senha padrão do produto é curta e repetida de propósito.
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

    return this.obterNoEscopo(autor, id);
  }

  /**
   * Apaga o acesso de vez — a linha some de `perfis`.
   *
   * Existe ao lado de desativar, e não no lugar dele, porque são respostas a
   * problemas diferentes. Desativar é para quem talvez volte: o histórico fica
   * na lista, o e-mail continua ocupado e reativar é um clique. Excluir é para
   * o acesso que nunca deveria ter existido — o cadastro de teste, o e-mail
   * digitado errado, a empresa que desistiu antes de começar. Sem esta rota,
   * esses três ficam para sempre na tela, desativados, e a lista de acessos
   * vira um cemitério que atrapalha achar quem importa.
   *
   * O que NÃO se perde junto: a trilha de auditoria. `logs_auditoria` não
   * referencia `perfis` e guarda `usuario_nome` copiado na linha, de propósito
   * — o que essa pessoa fez continua registrado depois de ela sumir. As duas
   * tabelas que referenciam o perfil (`canal_membros` e a caixa de avisos) têm
   * `on delete cascade`, então o vínculo com canais e os avisos pessoais somem
   * junto, que é o desejado: são coisas que só fazem sentido com o dono vivo.
   */
  async excluir(autor: UsuarioAutenticado, id: string, ip: string): Promise<void> {
    /*
     * Exclusão é da conta de administração, e só dela.
     *
     * Mais restrito que desativar, que qualquer admin faz na própria empresa,
     * e é de propósito: desativar tem volta, excluir não tem. Um admin de
     * empresa irritado apagando a própria equipe é um estrago sem desfazer, e
     * o cliente ligaria para você — que é quem tem o banco — para consertar.
     */
    if (autor.empresaId !== null) {
      throw new ForbiddenException(
        "Apenas a conta de administração exclui acessos. Desative o acesso em vez de excluir.",
      );
    }

    const alvo = await this.obterNoEscopo(autor, id);

    // Excluir a si mesmo é o único jeito de sair do sistema sem ninguém para
    // te readmitir: não há auto-cadastro e não há e-mail de recuperação.
    if (autor.id === id) {
      throw new BadRequestException("Você não pode excluir o próprio acesso.");
    }

    // A mesma trava de desativar: uma empresa sem administrador não tem
    // caminho de volta pelo produto, e aqui nem desfazer existe.
    if (alvo.papel === "admin") {
      await this.exigirOutroAdminAtivo(id);
    }

    /*
     * A auditoria é gravada ANTES do delete, e não depois.
     *
     * Depois, `alvo` já não existe para consultar, e um erro entre as duas
     * operações deixaria o acesso apagado sem registro nenhum de quem apagou —
     * exatamente a linha que se vai procurar quando alguém perguntar "cadê o
     * login do fulano?". Na ordem inversa, o pior caso é uma linha de
     * auditoria para uma exclusão que falhou, que é visível e explicável.
     */
    await this.auditoria.registrar({
      usuarioId: autor.id,
      usuarioNome: autor.nome,
      acao: "usuario.excluido",
      tipoEntidade: "usuario",
      entidadeId: id,
      entidadeRotulo: `${alvo.nome} <${alvo.email}>`,
      ip,
      detalhes: { papel: alvo.papel, ativo: alvo.ativo },
    });

    /*
     * `noEscopo` mesmo sendo exclusivo da conta global, para quem ele é um
     * no-op: se um dia a trava lá em cima afrouxar — um admin de empresa
     * ganhando o direito de excluir a própria gente —, este DELETE já nasce
     * incapaz de alcançar outra empresa. Sem ele, afrouxar a trava viraria
     * apagar perfil de cliente alheio com um uuid vindo da URL.
     */
    const { error } = await noEscopo(
      this.supabase.tabela("perfis").delete().eq("id", id),
      autor,
    );
    if (error) throw new Error(`Falha ao excluir usuário: ${error.message}`);
  }

  /**
   * Carrega o perfil por id, sem escopo.
   *
   * Só para quem JÁ sabe que o id é legítimo — hoje, `criar`, com o id que ela
   * mesma acabou de inserir. Todo caminho que recebe o id de fora precisa de
   * `obterNoEscopo`, ou o filtro por empresa some junto.
   */
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

  /**
   * O mesmo, restrito à empresa do autor.
   *
   * `COLUNAS_PERFIL` não traz `empresa_id` e não precisa: `noEscopo` filtra na
   * consulta, e um perfil de outra empresa some do resultado em vez de vir
   * marcado. Fora do escopo o perfil não existe — daí `NotFoundException` e
   * não `Forbidden`: dizer "existe, mas não é seu" já confirmaria que aquele
   * uuid é um usuário de outro cliente.
   */
  private async obterNoEscopo(autor: UsuarioAutenticado, id: string): Promise<Usuario> {
    const { data, error } = await noEscopo(
      this.supabase.tabela("perfis").select(COLUNAS_PERFIL).eq("id", id),
      autor,
    ).maybeSingle();

    if (error) throw new Error(`Falha ao carregar usuário: ${error.message}`);
    if (!data) throw new NotFoundException("Usuário não encontrado.");
    return paraUsuario(data as unknown as LinhaPerfil);
  }

  /**
   * Impede uma EMPRESA ficar sem nenhum administrador ativo.
   *
   * A contagem era global: bastava existir um admin em qualquer outra empresa
   * — ou a própria conta de administração do sistema, que sempre existe — para
   * a guarda liberar o rebaixamento do último admin de uma empresa. O cliente
   * ficava sem ninguém que pudesse criar acesso ou conectar canal, e sem
   * caminho de volta pelo produto. Quem corre o risco de ficar órfã é a empresa
   * do ALVO, então é ela que precisa ser contada — e não a do autor: a conta
   * global de administração, cuja empresa é nula, veria a contagem sem filtro
   * nenhum e liberaria o rebaixamento pelo mesmo motivo de antes.
   */
  private async exigirOutroAdminAtivo(excetoId: string): Promise<void> {
    const { data: linhaAlvo } = await this.supabase
      .tabela("perfis")
      .select("empresa_id")
      .eq("id", excetoId)
      .maybeSingle();

    const empresaDoAlvo = (linhaAlvo as { empresa_id: string | null } | null)?.empresa_id ?? null;

    let consulta = this.supabase
      .tabela("perfis")
      .select("id", { count: "exact", head: true })
      .eq("papel", "admin")
      .eq("ativo", true)
      .neq("id", excetoId);

    // Alvo sem empresa é outra conta global: aí o que não pode acabar são os
    // administradores DO SISTEMA, que são exatamente os de empresa nula.
    consulta =
      empresaDoAlvo === null
        ? consulta.is("empresa_id", null)
        : consulta.eq("empresa_id", empresaDoAlvo);

    const { count } = await consulta;

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
