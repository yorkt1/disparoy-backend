import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { z } from "zod";
import type { Canal, MembroCanal, MetodoPareamento } from "@disparoy/dominio";
import {
  canalAjusteSchema,
  canalEntradaSchema,
  formatarTelefone,
  limiteSugerido,
  statusDoGateway,
} from "@disparoy/dominio";
import { SupabaseService } from "../supabase/supabase.service";
import { AuditoriaService } from "../auditoria/auditoria.service";
import { WhatsappService } from "../whatsapp/whatsapp.service";
import {
  contatosDaInstancia,
  esquecerAgenda,
  estadoDaInstancia,
  excluirInstancia,
  fotoDaInstancia,
  numeroDaInstancia,
} from "../whatsapp/evolution-provider";
import { gerarPlanilhaContatos } from "../contatos/planilha";
import { BUCKET_MIDIA } from "../midia/midia.service";
import { ambiente } from "../config/ambiente";
import { empresaParaEscrita, noEscopo } from "../comum/escopo";
import { LimitesService } from "../comum/limites.service";
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

/** Campanha que ainda vai disparar — é a que dói ao excluir o canal. */
function ehAtiva(status: string): boolean {
  return status === "em_andamento" || status === "agendada" || status === "pausada_por_canal";
}

/** Nome do canal, com o número quando ele já é conhecido. */
function rotular(canal: Canal): string {
  return canal.numero ? `${canal.nome} (${formatarTelefone(canal.numero)})` : canal.nome;
}

@Injectable()
export class CanaisService {
  private readonly logger = new Logger(CanaisService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly auditoria: AuditoriaService,
    private readonly whatsapp: WhatsappService,
    private readonly limites: LimitesService,
  ) {}

  /**
   * Canais que o usuário pode operar.
   *
   * Admin vê todos; operador vê apenas aqueles em que foi vinculado. O filtro
   * acontece aqui e não no RLS porque a API usa a service role, que o ignora.
   */
  async listar(usuario: UsuarioAutenticado): Promise<Canal[]> {
    if (usuario.papel === "admin") {
      // `noEscopo` mesmo sendo admin: papel e empresa são coisas diferentes.
      // Admin de UMA empresa vê todos os canais DELA; só a conta global
      // (`empresaId` nulo) atravessa empresas.
      const { data, error } = await noEscopo(
        this.supabase.tabela("canais").select(COLUNAS_CANAL),
        usuario,
      ).order("nome");
      if (error) throw new Error(`Falha ao listar canais: ${error.message}`);
      return (data as unknown as LinhaCanal[]).map(paraCanal);
    }

    const { data, error } = await this.supabase
      .tabela("canal_membros")
      // `empresa_id` entra no SELECT só para o filtro abaixo — não vai para
      // `paraCanal`, que continua recebendo exatamente `COLUNAS_CANAL`.
      .select(`canais(${COLUNAS_CANAL}, empresa_id)`)
      .eq("perfil_id", usuario.id);

    if (error) throw new Error(`Falha ao listar canais: ${error.message}`);
    return ((data ?? []) as unknown as { canais: (LinhaCanal & { empresa_id: string }) | null }[])
      .map((l) => l.canais)
      .filter((c): c is LinhaCanal & { empresa_id: string } => c !== null)
      /*
       * O vínculo em `canal_membros` sozinho não prova que o canal é da
       * empresa de quem está olhando: a tabela liga perfil a canal e não
       * menciona empresa nenhuma. Um vínculo cruzado — plantado pelo furo que
       * `exigirAcesso` tinha, ou sobrando de um perfil que mudou de empresa —
       * fazia este caminho devolver canal alheio, com número e foto. O escopo
       * é o mesmo de `noEscopo`: a conta global vê tudo, o resto vê o seu.
       */
      .filter((c) => usuario.empresaId === null || c.empresa_id === usuario.empresaId)
      .map(paraCanal)
      .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  }

  async obter(usuario: UsuarioAutenticado, id: string): Promise<Canal> {
    const { data, error } = await noEscopo(
      this.supabase.tabela("canais").select(COLUNAS_CANAL).eq("id", id),
      usuario,
    ).maybeSingle();

    if (error) throw new Error(`Falha ao carregar canal: ${error.message}`);
    if (!data) throw new NotFoundException("Canal não encontrado.");

    await this.exigirAcesso(usuario, id);
    return paraCanal(data as unknown as LinhaCanal);
  }

  /** Operador sem vínculo não enxerga nem opera o canal. */
  async exigirAcesso(usuario: UsuarioAutenticado, canalId: string): Promise<void> {
    /*
     * A EMPRESA é conferida antes do papel, e não depois.
     *
     * `papel === "admin"` não diz nada sobre empresa: cada cliente tem o
     * próprio admin, e ele administra a empresa DELE. Com o early-return de
     * admin em primeiro lugar, todo caminho que chama `exigirAcesso` sem
     * passar por `obter()` — que é escopado — aceitava um `canalId` de outra
     * empresa: `campanhas.exigirCanaisProntos` deixava criar campanha com o
     * canal de outro cliente (e o worker dispararia pelo WhatsApp dele),
     * `vinculos` devolvia as campanhas daquela empresa, `listarMembros` os
     * nomes dos perfis, e `definirMembro`/`removerMembro` escreviam no canal
     * alheio. Só a conta global (`empresaId === null`) atravessa, que é o
     * acesso de suporte — mesma regra de `noEscopo`.
     */
    if (usuario.empresaId !== null) {
      const { data, error } = await this.supabase
        .tabela("canais")
        .select("id")
        .eq("id", canalId)
        .eq("empresa_id", usuario.empresaId)
        .maybeSingle();

      // Erro de leitura não pode virar "pode passar": sem resposta do banco,
      // não sabemos de quem é o canal, e o padrão seguro é recusar.
      if (error) throw new Error(`Falha ao conferir o canal: ${error.message}`);
      if (!data) throw new ForbiddenException("Você não tem acesso a este canal.");
    }

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
  ): Promise<{
    canal: Canal;
    metodo: MetodoPareamento;
    qr: string | null;
    codigo: string | null;
    expiraEm: string | null;
    aviso?: string;
  }> {
    const empresaId = empresaParaEscrita(usuario);

    /*
     * Teto de canais — antes de criar a instância na Evolution.
     *
     * A ordem importa: `iniciarSessaoQr` cria uma instância no servidor
     * Evolution, e ela sobrevive à recusa daqui. Barrar depois deixaria lixo
     * pareável no gateway que ninguém no produto consegue ver nem apagar.
     */
    await this.limites.exigirEspacoParaCanal(empresaId);

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
        // `?? null`, não `||`: o padrão passou a ser SEM teto, e `||` faria
        // qualquer ausência cair no limite sugerido do aquecimento de novo.
        limite_diario: dados.limiteDiario ?? null,
        estagio_aquecimento: dados.estagioAquecimento,
        criado_por: usuario.id,
        empresa_id: empresaId,
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
      const sessao = await this.whatsapp.iniciarSessaoQr(canal, {
        metodo: dados.metodoPareamento,
        numero: dados.numeroPareamento,
      });
      return {
        canal,
        metodo: sessao.metodo,
        qr: sessao.qr,
        codigo: sessao.codigo,
        expiraEm: sessao.expiraEm,
        ...(sessao.aviso ? { aviso: sessao.aviso } : {}),
      };
    } catch (e) {
      // O canal já existe no banco; a falha é só do pareamento. Devolver o
      // canal com o aviso deixa o operador tentar de novo pela listagem.
      return {
        canal,
        metodo: dados.metodoPareamento,
        qr: null,
        codigo: null,
        expiraEm: null,
        aviso: e instanceof Error ? e.message : "Não foi possível iniciar o pareamento.",
      };
    }
  }

  /**
   * Pergunta ao gateway o estado real da sessão, agora.
   *
   * Existe porque `canais.status` é cache do webhook, e a vigilância periódica
   * só roda se o WORKER estiver no ar — que é justamente o que não acontece
   * quando algo está errado. Sem esta rota, um canal fica "Conectado" na tela
   * por dias enquanto está offline, e todo erro que sai disso parece defeito do
   * sistema.
   *
   * Não é feito na listagem: seria uma chamada HTTP à Evolution por canal a
   * cada vez que alguém abre a tela.
   *
   * `confirmado: false` quando o gateway não respondeu. Nesse caso NADA é
   * gravado — não sabemos, e chutar aqui reintroduz o bug que esta função
   * existe para corrigir.
   */
  async verificar(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<{ canal: Canal; confirmado: boolean }> {
    const canal = await this.obter(usuario, id);

    if (canal.tipoConexao !== "qrcode") {
      throw new BadRequestException("Só canais de QR Code têm sessão para verificar.");
    }

    const estado = await estadoDaInstancia(canal.instanciaEvolution);
    const novoStatus = statusDoGateway(estado);

    if (novoStatus === null) {
      return { canal, confirmado: false };
    }

    const atualizacao: Record<string, unknown> = {
      status: novoStatus,
      estado_gateway: estado,
      estado_verificado_em: new Date().toISOString(),
    };

    // O número vem do gateway quando falta. Depender só do webhook deixava um
    // canal pareado sem número — e a tela, corretamente, dizia que o
    // pareamento não tinha terminado.
    if (canal.numero === null) {
      const numero = await numeroDaInstancia(canal.instanciaEvolution);
      if (numero) {
        atualizacao.numero = numero;
        atualizacao.conectado_em = new Date().toISOString();
      }
    }

    // A foto é buscada no pareamento e quando ainda não existe — não a cada
    // verificação, que roda de minuto em minuto.
    if (novoStatus === "conectado" && !canal.fotoUrl) {
      const foto = await this.guardarFoto(canal);
      if (foto) {
        atualizacao.foto_url = foto;
        atualizacao.foto_em = new Date().toISOString();
      }
    }

    const { data, error } = await this.supabase
      .tabela("canais")
      .update(atualizacao)
      .eq("id", id)
      .select(COLUNAS_CANAL)
      .single();

    if (error) throw new Error(`Falha ao verificar o canal: ${error.message}`);
    return { canal: paraCanal(data as unknown as LinhaCanal), confirmado: true };
  }

  /**
   * Abre um pareamento novo para um canal já cadastrado.
   *
   * O QR anterior expira em cerca de um minuto, então reconectar é o caminho
   * normal — e não uma exceção. O método pode ser diferente do usado na
   * criação: quem tentou pelo QR e não tinha uma segunda tela à mão troca para
   * o código aqui, sem precisar recriar o canal.
   */
  async reconectar(
    usuario: UsuarioAutenticado,
    id: string,
    opcoes: { metodo?: MetodoPareamento; numero?: string; forcar?: boolean } = {},
  ): Promise<{
    metodo: MetodoPareamento;
    qr: string | null;
    codigo: string | null;
    expiraEm: string;
    aviso?: string;
  }> {
    const canal = await this.obter(usuario, id);
    if (canal.tipoConexao !== "qrcode") {
      throw new BadRequestException("Canais de API Oficial não pareiam por QR Code.");
    }

    /*
     * Reconectar DERRUBA a sessão que estiver de pé — é o restart que produz o
     * código novo. Num canal que já está conectado isso não conserta nada e
     * pode cortar um disparo em andamento no meio.
     *
     * Perguntamos ao gateway em vez de olhar `canal.status`: o status local é
     * cache do webhook, e barrar por ele erraria dos dois lados — deixaria
     * passar quando o webhook morreu com a sessão viva, e barraria um canal
     * realmente caído que ficou marcado como conectado.
     */
    if (!opcoes.forcar && (await estadoDaInstancia(canal.instanciaEvolution)) === "open") {
      throw new ConflictException(
        "Este canal já está conectado. Reconectar vai derrubar a sessão atual e " +
          "interromper qualquer campanha em andamento nele. Confirme para prosseguir.",
      );
    }

    /*
     * `renovar: true` sempre que se reconecta.
     *
     * É a semântica da ação: quem chega aqui quer um pareamento NOVO, ou
     * porque o anterior expirou, ou porque a sessão caiu. Sem reiniciar, o
     * gateway devolveria o mesmo código de antes — que é justamente o que não
     * funciona mais.
     */
    const sessao = await this.whatsapp.iniciarSessaoQr(canal, { ...opcoes, renovar: true });

    // A agenda guardada descreve o número anterior tanto quanto `numero` e
    // `foto_url` logo abaixo — e é a única das três que não está no banco, então
    // limpar só as colunas deixaria justamente o dado pessoal para trás.
    esquecerAgenda(canal.instanciaEvolution);

    /*
     * Some tudo que descrevia o número ANTERIOR.
     *
     * A instância é a mesma, o número pode não ser. `numero` e `foto_url` só
     * eram preenchidos quando estavam vazios, então repareando com outro
     * chip o canal ficava exibindo a foto e o número de quem saiu — e o
     * `?v=${Date.now()}` do cache-busting nunca era regravado, porque
     * `guardarFoto` nem chegava a rodar. Zerando aqui, a verificação seguinte
     * busca os dois de novo pelo caminho que já existe.
     */
    const { error } = await this.supabase
      .tabela("canais")
      .update({ numero: null, foto_url: null, foto_em: null })
      .eq("id", id);
    if (error) {
      // Não derruba o pareamento: o QR na tela vale mais que a foto correta, e
      // a verificação periódica reescreve os dois de qualquer forma.
      this.logger.warn(`Não foi possível limpar número e foto de ${canal.nome}: ${error.message}`);
    }

    return {
      metodo: sessao.metodo,
      qr: sessao.qr,
      codigo: sessao.codigo,
      expiraEm: sessao.expiraEm,
      // O aviso vinha sendo descartado aqui: se o webhook não pôde ser
      // registrado, ou se o gateway devolveu o código anterior, era exatamente
      // nesta rota que o operador precisava ficar sabendo.
      ...(sessao.aviso ? { aviso: sessao.aviso } : {}),
    };
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

      /*
       * A agenda em cache não pode sobreviver ao número que saiu.
       *
       * `excluir` já esquecia, e o raciocínio é o mesmo aqui — só que este é o
       * caminho COMUM: desconectar e parear outro chip reaproveita a instância,
       * enquanto excluir o canal é raro. Sem isto, `contarContatos` e
       * `extrairContatos` entregam por até cinco minutos a agenda do chip
       * anterior para quem acabou de conectar o próprio, e o operador baixa uma
       * planilha com telefones de terceiros sem nenhum sinal de que estão
       * errados. É o vazamento que o comentário de `excluir` diz querer evitar,
       * entrando pela porta ao lado.
       */
      esquecerAgenda(canal.instanciaEvolution);
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

  /**
   * Extrai a agenda do número pareado como planilha.
   *
   * Nada é gravado: o arquivo sai e acaba aqui. É o outro lado da decisão de
   * não armazenar contatos — o operador extrai, edita no Excel e cola de volta
   * na campanha, e o painel nunca vira um cadastro paralelo do celular dele.
   *
   * Auditado porque é EXPORTAÇÃO DE DADO PESSOAL em massa: quem baixou a
   * agenda de qual número, e quando, é exatamente o tipo de pergunta que
   * aparece depois.
   */
  async extrairContatos(
    usuario: UsuarioAutenticado,
    id: string,
    ip: string,
  ): Promise<{ arquivo: Uint8Array; nome: string; total: number }> {
    const canal = await this.obter(usuario, id);

    if (canal.tipoConexao !== "qrcode") {
      throw new BadRequestException("Só canais de QR Code têm agenda para extrair.");
    }
    if (!(await this.temSessaoAberta(canal))) {
      // Sem sessão aberta a Evolution devolve lista vazia em vez de erro, e o
      // operador baixaria uma planilha com zero linhas achando que a agenda
      // dele está vazia.
      throw new BadRequestException(
        "O canal precisa estar conectado para extrair os contatos. Reconecte e tente de novo.",
      );
    }

    const contatos = await contatosDaInstancia(canal.instanciaEvolution);

    await this.auditoria.registrar({
      usuarioId: usuario.id,
      usuarioNome: usuario.nome,
      acao: "contatos.extraidos",
      tipoEntidade: "canal",
      entidadeId: canal.id,
      entidadeRotulo: rotular(canal),
      ip,
      detalhes: { total: contatos.length },
    });

    return {
      arquivo: gerarPlanilhaContatos(contatos),
      nome: `contatos-${apelidar(canal.nome)}.xlsx`,
      total: contatos.length,
    };
  }

  /**
   * Campanhas que usam este canal.
   *
   * Consultado ANTES de excluir, para a tela poder perguntar "estas campanhas
   * dependem dele, quer mesmo excluir?" em vez de deixar o operador clicar e
   * levar um erro. O aviso chega antes da ação, não depois.
   */
  async vinculos(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<{ id: string; nome: string; status: string }[]> {
    await this.exigirAcesso(usuario, id);

    const { data, error } = await this.supabase
      .tabela("campanha_canais")
      .select("campanhas(id, nome, status)")
      .eq("canal_id", id);

    if (error) throw new Error(`Falha ao listar campanhas do canal: ${error.message}`);

    return ((data ?? []) as unknown as {
      campanhas: { id: string; nome: string; status: string } | null;
    }[])
      .map((l) => l.campanhas)
      .filter((c): c is NonNullable<typeof c> => c !== null)
      // Ativas primeiro: são as que doem de verdade ao excluir o canal.
      .sort((a, b) => Number(ehAtiva(b.status)) - Number(ehAtiva(a.status)));
  }

  /**
   * Exclui o canal e a instância na Evolution.
   *
   * `campanha_canais` referencia o canal com ON DELETE RESTRICT, e isso fazia a
   * exclusão simplesmente falhar — o operador ficava com um canal morto na
   * lista para sempre, sem saída pelo produto.
   *
   * Agora o vínculo é removido junto, com `forcar`. O histórico não se perde:
   * `mensagens_enviadas.canal_id` e `campanha_contatos.canal_id` são
   * `ON DELETE SET NULL`, então o que foi enviado continua registrado — some
   * apenas a associação "esta campanha pode usar este canal", que não faz
   * sentido depois que o canal deixou de existir.
   */
  /**
   * Baixa a foto do número e guarda no nosso Storage.
   *
   * Chamado quando o pareamento é confirmado. Nunca lança: foto é enfeite, e
   * derrubar a confirmação de conexão por causa dela seria trocar o essencial
   * pelo acessório.
   *
   * O caminho no bucket é fixo por canal (`canais/<id>.jpg`) com `upsert`:
   * reconectar o mesmo canal atualiza a imagem em vez de acumular arquivo
   * órfão a cada pareamento.
   */
  private async guardarFoto(canal: Canal): Promise<string | null> {
    try {
      const foto = await fotoDaInstancia(canal.instanciaEvolution);
      if (!foto) return null;

      const caminho = `canais/${canal.id}.jpg`;
      const { error } = await this.supabase.db.storage
        .from(BUCKET_MIDIA)
        .upload(caminho, foto.bytes, { contentType: foto.tipo, upsert: true });

      if (error) {
        this.logger.warn(`Não foi possível guardar a foto de ${canal.nome}: ${error.message}`);
        return null;
      }

      const base = ambiente().SUPABASE_URL.replace(/\/+$/, "");
      // `?v=` com o instante: sem isso o navegador serve a foto antiga do
      // cache depois de uma troca de imagem no mesmo caminho.
      return `${base}/storage/v1/object/public/${BUCKET_MIDIA}/${caminho}?v=${Date.now()}`;
    } catch (e) {
      this.logger.warn(`Falha ao buscar a foto de ${canal.nome}: ${String(e)}`);
      return null;
    }
  }

  /**
   * Quantos contatos a agenda tem AGORA.
   *
   * Existe por causa de um comportamento do WhatsApp: logo depois do
   * pareamento, a agenda ainda está sendo sincronizada do celular para o
   * gateway, e `findContacts` responde uma lista VAZIA — sem erro nenhum.
   * Quem clicava em "Contatos" nesse instante recebia "nenhum contato na
   * agenda deste número", que é falso: a agenda existe, só não chegou.
   *
   * A tela consulta esta rota até vir um número maior que zero, e só então
   * baixa a planilha. Devolver só a contagem evita transferir 200 KB a cada
   * tentativa.
   */
  async contarContatos(usuario: UsuarioAutenticado, id: string): Promise<{ total: number }> {
    const canal = await this.obter(usuario, id);
    if (canal.tipoConexao !== "qrcode") return { total: 0 };
    if (!(await this.temSessaoAberta(canal))) return { total: 0 };
    return { total: (await contatosDaInstancia(canal.instanciaEvolution)).length };
  }

  /**
   * O canal tem sessão aberta AGORA?
   *
   * `canais.status` sozinho não responde: ele é cache do webhook, e o webhook
   * morre calado — foi exatamente o que 833b580 corrigiu na vigilância do
   * worker ("o dado sempre esteve no gateway; faltava perguntar"). As rotas de
   * contatos repetiam o mesmo engano: com o webhook fora do ar, um canal
   * pareado e funcionando ficava respondendo contagem zero, e a tela concluía
   * "a agenda ainda não chegou" para sempre. Acusar o WhatsApp do cliente por
   * uma falha nossa é precisamente a confusão que `docs/ARQUITETURA-ATRIBUICAO-
   * DE-FALHA.md` existe para impedir.
   *
   * O gateway só é consultado quando o cache diz NÃO. Quando ele diz sim já
   * concorda com o que vamos fazer, e perguntar assim mesmo colocaria uma
   * chamada HTTP à Evolution em cada volta do laço de contagem.
   *
   * `indisponivel` conta como fechado, mas sem gravar nada: não conseguir
   * perguntar não é a mesma coisa que ter perguntado e ouvido "caiu", e quem
   * grava status verificado é `verificar()`.
   */
  private async temSessaoAberta(canal: Canal): Promise<boolean> {
    if (canal.status === "conectado") return true;
    return (await estadoDaInstancia(canal.instanciaEvolution)) === "open";
  }

  async excluir(
    usuario: UsuarioAutenticado,
    id: string,
    ip: string,
    forcar = false,
  ): Promise<void> {
    const canal = await this.obter(usuario, id);
    const campanhas = await this.vinculos(usuario, id);

    if (campanhas.length > 0 && !forcar) {
      // A tela normalmente já perguntou antes de chegar aqui; esta guarda
      // existe para quem chamar a API direto.
      throw new ConflictException(
        `Este canal está vinculado a ${campanhas.length} campanha(s). ` +
          "Confirme a exclusão para desvincular e excluir mesmo assim.",
      );
    }

    if (campanhas.length > 0) {
      const { error } = await this.supabase
        .tabela("campanha_canais")
        .delete()
        .eq("canal_id", id);
      if (error) throw new Error(`Falha ao desvincular campanhas: ${error.message}`);
    }

    const { error } = await this.supabase.tabela("canais").delete().eq("id", id);
    if (error) throw new Error(`Falha ao excluir canal: ${error.message}`);

    // A agenda em cache não pode sobreviver ao canal: um número novo criado
    // com a mesma instância herdaria os contatos do anterior.
    esquecerAgenda(canal.instanciaEvolution);

    // Depois do banco: apagar a instância primeiro e falhar no DELETE deixaria
    // um canal no painel apontando para uma instância que não existe mais.
    await excluirInstancia(canal.instanciaEvolution);

    await this.auditoria.registrar({
      usuarioId: usuario.id,
      usuarioNome: usuario.nome,
      acao: "canal.excluido",
      tipoEntidade: "canal",
      entidadeId: id,
      entidadeRotulo: rotular(canal),
      ip,
      detalhes: {
        campanhasDesvinculadas: campanhas.length,
        campanhas: campanhas.map((c) => c.nome),
      },
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

    /*
     * O `perfilId` vem do corpo da requisição, então precisa ser conferido.
     *
     * `exigirAcesso` acima responde "o AUTOR pode mexer neste canal?" e não diz
     * nada sobre o alvo. Sem esta checagem, um admin vinculava ao próprio canal
     * um perfil de OUTRA empresa — bastava o uuid — e entregava a gente de fora
     * o acesso operacional ao número: extrair a agenda, ver as campanhas, e
     * (por `listar`) o canal aparecendo na tela dela.
     *
     * A conta global escolhe livremente: é ela quem cria os acessos de cada
     * empresa, mesma regra de `usuarios.criar`.
     */
    if (usuario.empresaId !== null) {
      const { data: alvo, error: erroAlvo } = await this.supabase
        .tabela("perfis")
        .select("id")
        .eq("id", perfilId)
        .eq("empresa_id", usuario.empresaId)
        .maybeSingle();

      if (erroAlvo) throw new Error(`Falha ao conferir o operador: ${erroAlvo.message}`);
      if (!alvo) {
        throw new ForbiddenException("Este usuário não pertence à sua empresa.");
      }
    }

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
