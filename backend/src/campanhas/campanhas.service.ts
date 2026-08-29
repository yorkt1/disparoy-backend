import { ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type {
  Campanha,
  CampanhaEdicao,
  CampanhaEntrada,
  ContatoDaCampanha,
  MetricasDashboard,
  Paginado,
  RespostaRecebida,
  ResumoCampanha,
  ResumoSituacao,
  SituacaoContato,
  StatusCampanha,
} from "@disparoy/dominio";
import { LIMITES, MAX_RESPOSTAS_NA_LISTA, percentual, slugify } from "@disparoy/dominio";
import { SupabaseService } from "../supabase/supabase.service";
import { AuditoriaService } from "../auditoria/auditoria.service";
import { CanaisService } from "../canais/canais.service";
import { FilaService } from "../fila/fila.service";
import {
  COLUNAS_CAMPANHA,
  paraCampanha,
  paraContatoDaCampanha,
  paraResumoCampanha,
  variaveis,
  COLUNAS_CONTATO_CAMPANHA,
  type LinhaCampanha,
  type LinhaContatoCampanha,
} from "../comum/mapeadores";
import {
  chavesDeVariaveis,
  montarCsv,
  MAX_RESPOSTAS,
  type LinhaRelatorio,
  type RespostaDoContato,
  type TipoResposta,
} from "./relatorio";
import type { UsuarioAutenticado } from "../auth/auth.guard";
import { empresaParaEscrita, noEscopo } from "../comum/escopo";
import { LimitesService } from "../comum/limites.service";

export interface ConsultaContatos {
  pagina?: number;
  porPagina?: number;
  situacao?: SituacaoContato | "todas";
  busca?: string;
}

export interface ConsultaCampanhas {
  pagina?: number;
  porPagina?: number;
  busca?: string;
  status?: StatusCampanha | "todas";
}

/**
 * Tamanho da página do relatório.
 *
 * Mil é o teto do PostgREST: pedir mais devolve mil e não avisa, e uma
 * exportação silenciosamente truncada é o pior defeito possível numa planilha
 * que o operador vai usar para cobrar o próprio cliente.
 */
const PAGINA_RELATORIO = 1000;

interface LinhaContatoRelatorio {
  id: number;
  telefone: string;
  status: string;
  motivo: string | null;
  variaveis: unknown;
  canal_id: string | null;
  contatos?: { nome: string | null } | null;
}

interface LinhaEnvio {
  campanha_contato_id: number;
  enviada_em: string | null;
  lida_em: string | null;
}

interface LinhaResposta {
  campanha_contato_id: number;
  texto: string | null;
  tipo: TipoResposta;
  recebida_em?: string | null;
}

/** O que sobra de todas as mensagens de um contato depois de dobradas. */
interface EnvioResumido {
  primeiro: string | null;
  lida: boolean;
}

@Injectable()
export class CampanhasService {
  private readonly logger = new Logger(CampanhasService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly auditoria: AuditoriaService,
    private readonly canais: CanaisService,
    private readonly fila: FilaService,
    private readonly limites: LimitesService,
  ) {}

  // ------------------------------------------------------------------------
  // Leitura
  // ------------------------------------------------------------------------

  async listar(
    usuario: UsuarioAutenticado,
    q: ConsultaCampanhas = {},
  ): Promise<Paginado<ResumoCampanha>> {
    const pagina = Math.max(q.pagina ?? 1, 1);
    const porPagina = Math.min(Math.max(q.porPagina ?? 10, 5), 100);
    const de = (pagina - 1) * porPagina;

    let consulta = noEscopo(
      this.supabase
        .tabela("campanhas")
        .select(COLUNAS_CAMPANHA, { count: "exact" })
        .order("criada_em", { ascending: false })
        .range(de, de + porPagina - 1),
      usuario,
    );

    if (q.status && q.status !== "todas") consulta = consulta.eq("status", q.status);
    if (q.busca) consulta = consulta.ilike("nome", `%${q.busca.replace(/[,()]/g, " ")}%`);

    const { data, error, count } = await consulta;
    if (error) throw new Error(`Falha ao listar campanhas: ${error.message}`);

    const total = count ?? 0;
    return {
      itens: (data as unknown as LinhaCampanha[]).map(paraResumoCampanha),
      pagina,
      porPagina,
      total,
      totalPaginas: Math.max(Math.ceil(total / porPagina), 1),
    };
  }

  async obter(usuario: UsuarioAutenticado, id: string): Promise<Campanha> {
    const { data, error } = await noEscopo(
      this.supabase.tabela("campanhas").select(COLUNAS_CAMPANHA).eq("id", id),
      usuario,
    ).maybeSingle();

    if (error) throw new Error(`Falha ao carregar campanha: ${error.message}`);
    if (!data) throw new NotFoundException("Campanha não encontrada.");
    return paraCampanha(data as unknown as LinhaCampanha);
  }

  /** Amostra de contatos: a tela de detalhes mostra os primeiros, não os 20 mil. */
  async amostraDeContatos(
    usuario: UsuarioAutenticado,
    id: string,
    limite = 50,
  ): Promise<ContatoDaCampanha[]> {
    // O escopo vem de `obter`, que confere o dono da campanha antes: filtrar
    // `campanha_contatos` por empresa não é possível — a coluna não existe lá,
    // e nem deve, porque o dono é a campanha.
    await this.obter(usuario, id);

    const { data } = await this.supabase
      .tabela("campanha_contatos")
      .select(COLUNAS_CONTATO_CAMPANHA)
      .eq("campanha_id", id)
      .order("id")
      .limit(limite);

    const linhas = (data ?? []) as unknown as LinhaContatoCampanha[];
    const respostas = await this.textosDasRespostas(id, linhas);
    return linhas.map((l) => paraContatoDaCampanha(l, respostas.get(l.id) ?? []));
  }

  /**
   * Os contatos da campanha, paginados e filtráveis por situação.
   *
   * É a tela que responde "quem respondeu?" — pergunta que o painel não sabia
   * responder: ele mostrava o TOTAL de respostas e uma amostra de telefones
   * sem estado nenhum. Quem disparava e recebia resposta não via nada mudar.
   *
   * O filtro vai ao banco em vez de ao navegador porque a campanha tem dezenas
   * de milhares de linhas, e o `situacao` é coluna gerada justamente para que
   * filtro e contagem usem a mesma regra que a lista mostra.
   *
   * O resumo vem junto na mesma resposta: são os números dos próprios botões
   * de filtro, e buscá-los numa segunda chamada faria a contagem piscar
   * desatualizada ao lado da lista já trocada.
   */
  async contatosDaCampanha(
    usuario: UsuarioAutenticado,
    id: string,
    q: ConsultaContatos = {},
  ): Promise<Paginado<ContatoDaCampanha> & { resumo: ResumoSituacao }> {
    // O escopo vem daqui: `campanha_contatos` não tem `empresa_id`, e nem
    // deve — o dono é a campanha, e `obter` lança para campanha de outra.
    await this.obter(usuario, id);

    const pagina = Math.max(q.pagina ?? 1, 1);
    const porPagina = Math.min(Math.max(q.porPagina ?? 25, 5), 100);
    const de = (pagina - 1) * porPagina;

    let consulta = this.supabase
      .tabela("campanha_contatos")
      .select(COLUNAS_CONTATO_CAMPANHA, { count: "exact" })
      .eq("campanha_id", id)
      .order("id")
      .range(de, de + porPagina - 1);

    if (q.situacao && q.situacao !== "todas") consulta = consulta.eq("situacao", q.situacao);
    // Só telefone: o nome mora em `contatos`, e filtrar por coluna de tabela
    // embutida no PostgREST vira `inner join` implícito que descarta silen-
    // ciosamente todo contato sem cadastro — que é a maioria desde que o
    // público passou a ser efêmero.
    if (q.busca) consulta = consulta.ilike("telefone", `%${q.busca.replace(/\D/g, "")}%`);

    const { data, error, count } = await consulta;
    if (error) throw new Error(`Falha ao listar contatos da campanha: ${error.message}`);

    const { data: resumo } = await this.supabase.db.rpc("resumo_situacao_campanha", {
      p_campanha_id: id,
    });

    const linhas = (data ?? []) as unknown as LinhaContatoCampanha[];
    const textos = await this.textosDasRespostas(id, linhas);

    const total = count ?? 0;
    return {
      itens: linhas.map((l) => paraContatoDaCampanha(l, textos.get(l.id) ?? [])),
      pagina,
      porPagina,
      total,
      totalPaginas: Math.max(Math.ceil(total / porPagina), 1),
      resumo: (resumo ?? {}) as ResumoSituacao,
    };
  }

  /**
   * O TEXTO das últimas respostas dos contatos JÁ carregados nesta página.
   *
   * O painel contava respostas e nunca mostrava nenhuma. O texto está gravado
   * desde a migration `20260826000100` e só saía pelo CSV — o operador via "3"
   * numa coluna e tinha de baixar uma planilha para descobrir que uma delas
   * era "pode me ligar agora?". Esta consulta é o que fecha esse buraco.
   *
   * Restrita aos ids da PÁGINA (no máximo 100) e só aos que têm `respostas > 0`:
   * é o que impede a lista de campanha de 20 mil contatos virar uma varredura
   * da tabela inteira a cada troca de página. Campanha sem resposta nenhuma
   * não faz consulta.
   *
   * Ordenada por chegada e cortada nas ÚLTIMAS: quem respondeu quinze vezes
   * está esperando por causa da última, não da primeira — ao contrário do CSV,
   * que guarda as primeiras porque lá a pergunta é "o que essa campanha
   * provocou", não "o que eu preciso responder agora".
   */
  private async textosDasRespostas(
    campanhaId: string,
    linhas: LinhaContatoCampanha[],
  ): Promise<Map<number, RespostaRecebida[]>> {
    const porContato = new Map<number, RespostaRecebida[]>();
    const ids = linhas.filter((l) => (l.respostas ?? 0) > 0).map((l) => l.id);
    if (ids.length === 0) return porContato;

    const { data, error } = await this.supabase
      .tabela("respostas_recebidas")
      .select("campanha_contato_id, texto, tipo, recebida_em")
      .eq("campanha_id", campanhaId)
      .in("campanha_contato_id", ids)
      // `id` desempata: o WhatsApp manda o timestamp em segundos, então duas
      // respostas seguidas têm o mesmo `recebida_em` e sem critério estável a
      // ordem muda a cada recarga da tela.
      .order("recebida_em", { ascending: false })
      .order("id", { ascending: false });

    /*
     * Aviso, e não exceção: a resposta é um extra da tela de contatos. Derrubar
     * a listagem inteira porque o texto não veio deixaria o operador sem ver
     * NEM quem respondeu — pior do que o problema que este método resolve.
     */
    if (error) {
      this.logger.warn(`Não foi possível ler o texto das respostas: ${error.message}`);
      return porContato;
    }

    for (const linha of (data ?? []) as unknown as LinhaResposta[]) {
      const lista = porContato.get(linha.campanha_contato_id) ?? [];
      if (lista.length >= MAX_RESPOSTAS_NA_LISTA) continue;
      lista.push({
        texto: linha.texto ?? "",
        tipo: linha.tipo,
        recebidaEm: linha.recebida_em ?? "",
      });
      porContato.set(linha.campanha_contato_id, lista);
    }

    return porContato;
  }

  /**
   * O relatório da campanha: uma linha por contato, com o que ele respondeu.
   *
   * É a única tela do produto que mostra o TEXTO da resposta, e mostrá-lo não
   * custa a notificação do celular do cliente: o painel só lê o que o webhook
   * gravou, e nada em nenhum caminho chama `chat/markMessageAsRead`. Ver o
   * comentário em `tratarMensagemRecebida`.
   *
   * Auditado como o download da agenda em `canais.service`, e pelo mesmo
   * motivo: é EXPORTAÇÃO DE DADO PESSOAL em massa, agora com o agravante de
   * levar junto o que os contatos escreveram. Quem baixou o quê, e quando, é a
   * pergunta que aparece depois.
   *
   * O arquivo inteiro é montado em memória. Campanha de dezenas de milhares de
   * contatos dá alguns MB de texto, o que a réplica aguenta; o que não caberia
   * é uma campanha de milhões, e nesse dia isto vira streaming.
   */
  async relatorio(
    usuario: UsuarioAutenticado,
    id: string,
    ip: string,
  ): Promise<{ arquivo: string; nome: string; total: number }> {
    const campanha = await this.obter(usuario, id);

    // Em série, e não `Promise.all`: as três consultas varrem a mesma campanha
    // e disparar as três de uma vez triplica o pico no banco sem encurtar nada
    // que o operador perceba — ele já está esperando um download.
    const contatos = await this.contatosDoRelatorio(id);
    const envios = await this.enviosPorContato(id);
    const respostas = await this.respostasPorContato(id);
    const canais = await this.canaisDoRelatorio(usuario, contatos);

    const linhas: LinhaRelatorio[] = contatos.map((c) => {
      const envio = envios.get(c.id);
      const canal = c.canal_id ? canais.get(c.canal_id) : undefined;
      return {
        envio: envio?.primeiro ?? null,
        canalNome: canal?.nome ?? null,
        canalNumero: canal?.numero ?? null,
        nome: c.contatos?.nome ?? null,
        telefone: c.telefone,
        lida: envio?.lida ?? false,
        respostas: respostas.get(c.id) ?? [],
        status: c.status,
        motivo: c.motivo,
        variaveis: variaveis(c.variaveis),
      };
    });

    await this.auditoria.registrar({
      usuarioId: usuario.id,
      usuarioNome: usuario.nome,
      acao: "campanha.relatorio_exportado",
      tipoEntidade: "campanha",
      entidadeId: id,
      entidadeRotulo: campanha.nome,
      ip,
      detalhes: { contatos: linhas.length },
    });

    const dia = new Date().toISOString().slice(0, 10);
    return {
      arquivo: montarCsv(linhas, chavesDeVariaveis(linhas)),
      nome: `relatorio-${slugify(campanha.nome)}-${dia}.csv`,
      total: linhas.length,
    };
  }

  /**
   * Todos os contatos da campanha, e não a amostra de 50.
   *
   * Paginado porque o PostgREST corta em 1000 linhas por resposta e não avisa:
   * sem isto, a campanha de 20 mil contatos exportaria as primeiras mil e o
   * operador não teria como saber que faltaram 19 mil.
   */
  private async contatosDoRelatorio(id: string): Promise<LinhaContatoRelatorio[]> {
    const tudo: LinhaContatoRelatorio[] = [];

    for (let de = 0; ; de += PAGINA_RELATORIO) {
      const { data, error } = await this.supabase
        .tabela("campanha_contatos")
        .select("id, telefone, status, motivo, variaveis, canal_id, contatos(nome)")
        .eq("campanha_id", id)
        .order("id")
        .range(de, de + PAGINA_RELATORIO - 1);

      if (error) throw new Error(`Falha ao ler os contatos da campanha: ${error.message}`);
      const lote = (data ?? []) as unknown as LinhaContatoRelatorio[];
      tudo.push(...lote);
      if (lote.length < PAGINA_RELATORIO) return tudo;
    }
  }

  /**
   * Primeiro envio e leitura, por contato.
   *
   * Dobrado por página em vez de acumulado: a campanha tem uma linha de
   * `mensagens_enviadas` por PASSO da sequência por contato, então 20 mil
   * contatos numa sequência de 5 são 100 mil linhas — e o que sobra delas são
   * dois campos por contato.
   *
   * "Lida" é qualquer passo lido, não o último: quem leu a primeira mensagem
   * leu a campanha, e exigir leitura do passo final marcaria como não lida
   * toda campanha que o contato interrompeu respondendo.
   */
  private async enviosPorContato(id: string): Promise<Map<number, EnvioResumido>> {
    const porContato = new Map<number, EnvioResumido>();

    for (let de = 0; ; de += PAGINA_RELATORIO) {
      const { data, error } = await this.supabase
        .tabela("mensagens_enviadas")
        .select("campanha_contato_id, enviada_em, lida_em")
        .eq("campanha_id", id)
        .order("id")
        .range(de, de + PAGINA_RELATORIO - 1);

      if (error) throw new Error(`Falha ao ler as mensagens da campanha: ${error.message}`);
      const lote = (data ?? []) as unknown as LinhaEnvio[];

      for (const linha of lote) {
        const atual = porContato.get(linha.campanha_contato_id);
        const primeiro =
          atual?.primeiro && (!linha.enviada_em || atual.primeiro <= linha.enviada_em)
            ? atual.primeiro
            : linha.enviada_em;

        porContato.set(linha.campanha_contato_id, {
          primeiro: primeiro ?? null,
          lida: (atual?.lida ?? false) || linha.lida_em !== null,
        });
      }

      if (lote.length < PAGINA_RELATORIO) return porContato;
    }
  }

  /** As respostas de cada contato, em ordem de chegada, cortadas em `MAX_RESPOSTAS`. */
  private async respostasPorContato(id: string): Promise<Map<number, RespostaDoContato[]>> {
    const porContato = new Map<number, RespostaDoContato[]>();

    for (let de = 0; ; de += PAGINA_RELATORIO) {
      const { data, error } = await this.supabase
        .tabela("respostas_recebidas")
        .select("campanha_contato_id, texto, tipo")
        .eq("campanha_id", id)
        // `id` desempata: duas respostas no mesmo segundo têm o mesmo
        // `recebida_em` (o WhatsApp manda o timestamp em segundos), e sem
        // critério estável a ordem muda a cada download.
        .order("recebida_em")
        .order("id")
        .range(de, de + PAGINA_RELATORIO - 1);

      if (error) throw new Error(`Falha ao ler as respostas da campanha: ${error.message}`);
      const lote = (data ?? []) as unknown as LinhaResposta[];

      for (const linha of lote) {
        const lista = porContato.get(linha.campanha_contato_id) ?? [];
        // Corta aqui, e não no fim: quem respondeu 200 vezes não deve ocupar
        // 200 posições de memória para ter 195 descartadas na montagem.
        if (lista.length >= MAX_RESPOSTAS) continue;
        lista.push({ texto: linha.texto ?? "", tipo: linha.tipo });
        porContato.set(linha.campanha_contato_id, lista);
      }

      if (lote.length < PAGINA_RELATORIO) return porContato;
    }
  }

  /**
   * Nome e número dos canais que aparecem na planilha.
   *
   * Sai dos contatos e não de `campanha.canaisIds` porque o canal pode ter
   * sido tirado da campanha depois do disparo — e a coluna `conexao` precisa
   * dizer de qual número a mensagem REALMENTE saiu, não de quais poderia ter
   * saído hoje.
   */
  private async canaisDoRelatorio(
    usuario: UsuarioAutenticado,
    contatos: LinhaContatoRelatorio[],
  ): Promise<Map<string, { nome: string; numero: string | null }>> {
    const ids = [...new Set(contatos.map((c) => c.canal_id).filter((c): c is string => !!c))];
    if (ids.length === 0) return new Map();

    // Escopada mesmo com os ids vindo de uma campanha já conferida por
    // `obter()`: `canais` tem `empresa_id`, e uma consulta que PODE passar por
    // `noEscopo` e não passa é a que sobra quando o vínculo entre campanha e
    // canal ganhar um caminho novo.
    const { data, error } = await noEscopo(
      this.supabase.tabela("canais").select("id, nome, numero"),
      usuario,
    ).in("id", ids);

    if (error) throw new Error(`Falha ao ler os canais da campanha: ${error.message}`);

    return new Map(
      ((data ?? []) as unknown as { id: string; nome: string; numero: string | null }[]).map(
        (c) => [c.id, { nome: c.nome, numero: c.numero }],
      ),
    );
  }

  async metricasDashboard(usuario: UsuarioAutenticado): Promise<MetricasDashboard> {
    const [campanhas, elegiveis, optOut] = await Promise.all([
      noEscopo(
        this.supabase
          .tabela("campanhas")
          .select(
            "iniciada_em, total_enviadas, total_entregues, total_lidas, total_falhas, total_respostas",
          ),
        usuario,
      ),
      /*
       * "Contatos elegíveis" perdeu o sentido junto com o cadastro: não existe
       * mais uma base a partir da qual escolher. O que sobrou de contável é
       * quem pediu para sair, e ele vale como número de conformidade.
       *
       * Devolver 0 aqui é honesto; inventar a contagem de uma tabela que o
       * produto não usa mais seria mostrar um número que não significa nada.
       */
      Promise.resolve({ count: 0 }),
      noEscopo(
        this.supabase.tabela("opt_outs").select("id", { count: "exact", head: true }),
        usuario,
      ),
    ]);

    const inicioDoDia = new Date();
    inicioDoDia.setHours(0, 0, 0, 0);

    const linhas = (campanhas.data ?? []) as {
      iniciada_em: string | null;
      total_enviadas: number;
      total_entregues: number;
      total_lidas: number;
      total_falhas: number;
      total_respostas: number;
    }[];

    const agregado = linhas.reduce(
      (acc, c) => {
        acc.enviadas += c.total_enviadas;
        acc.entregues += c.total_entregues;
        acc.lidas += c.total_lidas;
        acc.falhas += c.total_falhas;
        acc.respostas += c.total_respostas;
        if (c.iniciada_em) {
          acc.campanhas += 1;
          if (new Date(c.iniciada_em) >= inicioDoDia) acc.hoje += c.total_enviadas;
        }
        return acc;
      },
      { enviadas: 0, entregues: 0, lidas: 0, falhas: 0, respostas: 0, hoje: 0, campanhas: 0 },
    );

    return {
      totalCampanhasEnviadas: agregado.campanhas,
      mensagensHoje: agregado.hoje,
      taxaEntrega: percentual(agregado.entregues, agregado.enviadas),
      taxaLeitura: percentual(agregado.lidas, agregado.entregues),
      respostasRecebidas: agregado.respostas,
      contatosElegiveis: elegiveis.count ?? 0,
      contatosOptOut: optOut.count ?? 0,
      porStatus: {
        enviadas: agregado.enviadas,
        entregues: agregado.entregues,
        lidas: agregado.lidas,
        falhas: agregado.falhas,
      },
    };
  }

  // ------------------------------------------------------------------------
  // Escrita
  // ------------------------------------------------------------------------

  /**
   * Cria a campanha e, se a ação for disparar, enfileira o job de início.
   *
   * Nada é enviado dentro desta requisição: a API só grava e enfileira. Quem
   * envia é o worker — com 15–45 s entre contatos, uma campanha de 3.000
   * pessoas leva ~25 horas e não cabe em request HTTP nenhum.
   */
  async criar(
    usuario: UsuarioAutenticado,
    dados: CampanhaEntrada,
    ip: string,
  ): Promise<ResumoCampanha> {
    await this.exigirCanaisProntos(usuario, dados.canaisIds);

    const status: StatusCampanha =
      dados.acao === "rascunho" ? "rascunho" : dados.agendadaPara ? "agendada" : "em_andamento";

    /*
     * Teto de campanhas simultâneas — antes de gravar qualquer coisa.
     *
     * Rascunho não conta e não é barrado: ele não ocupa fila nenhuma, e
     * impedir alguém de ESCREVER a próxima campanha porque as três atuais
     * ainda rodam seria transformar uma proteção de capacidade em obstáculo de
     * trabalho.
     *
     * `usuario.empresaId` e não `empresaParaEscrita`: a conta global cai no
     * `empresaParaEscrita` do INSERT logo abaixo, com a mensagem própria dele
     * ("entre com o acesso da empresa"). Antecipá-la aqui só trocaria uma
     * mensagem clara por outra igual, mais cedo.
     */
    if (status !== "rascunho" && usuario.empresaId !== null) {
      await this.limites.exigirEspacoParaCampanha(usuario.empresaId);
    }

    const { data, error } = await this.supabase
      .tabela("campanhas")
      .insert({
        nome: dados.nome,
        status,
        // `lista_id` continua na tabela pelas campanhas antigas, mas as novas
        // não têm lista: o público entra direto, vindo da planilha ou colagem.
        lista_id: null,
        // `empresaParaEscrita`, não `usuario.empresaId`: a conta global tem
        // empresa nula, e passá-la direto gravava NULL — furando o default da
        // coluna e deixando a campanha sem dono, invisível para qualquer
        // filtro por empresa. Recusar é o comportamento certo.
        empresa_id: empresaParaEscrita(usuario),
        sequencia: dados.sequencia,
        intervalo_contatos_min: dados.intervaloEntreContatos.minSegundos,
        intervalo_contatos_max: dados.intervaloEntreContatos.maxSegundos,
        intervalo_mensagens_min: dados.intervaloEntreMensagens.minSegundos,
        intervalo_mensagens_max: dados.intervaloEntreMensagens.maxSegundos,
        validar_numeros: dados.validarNumeros,
        agendada_para: dados.agendadaPara,
        template_principal: dados.sequencia[0]?.templateId ?? null,
        criada_por: usuario.id,
        iniciada_em: status === "em_andamento" ? new Date().toISOString() : null,
      })
      .select("id")
      .single();

    if (error) throw new Error(`Falha ao criar campanha: ${error.message}`);
    const campanhaId = (data as { id: string }).id;

    await this.vincularCanais(campanhaId, dados.canaisIds);

    /**
     * O filtro de consentimento roda no banco, não aqui: é a última barreira
     * antes de a mensagem existir, e nenhum caminho de código a contorna.
     */
    const { data: total, error: erroPopular } = await this.supabase.db.rpc(
      "popular_publico_da_campanha",
      { p_campanha_id: campanhaId, p_publico: dados.publico },
    );
    if (erroPopular) throw new Error(`Falha ao carregar os contatos: ${erroPopular.message}`);

    const elegiveis = Number(total ?? 0);
    if (dados.acao === "disparar" && elegiveis === 0) {
      // Sem contato elegível não há campanha — e deixar em `em_andamento`
      // criaria uma campanha eternamente parada em 0%.
      await this.supabase.tabela("campanhas").update({ status: "rascunho" }).eq("id", campanhaId);
      throw new ConflictException(
        "Nenhum dos contatos pode receber mensagem: todos já pediram para sair.",
      );
    }

    await this.auditoria.registrar({
      usuarioId: usuario.id,
      usuarioNome: usuario.nome,
      acao: dados.acao === "rascunho" ? "campanha.rascunho_salvo" : "campanha.criada",
      tipoEntidade: "campanha",
      entidadeId: campanhaId,
      entidadeRotulo: dados.nome,
      ip,
      detalhes: {
        contatosElegiveis: elegiveis,
        canais: dados.canaisIds.length,
        mensagensPorContato: dados.sequencia.length,
      },
    });

    if (status !== "rascunho") {
      await this.fila.agendarCampanha({ campanhaId, rodada: 0 }, dados.agendadaPara);
      await this.auditoria.registrar({
        usuarioId: usuario.id,
        usuarioNome: usuario.nome,
        acao: "campanha.iniciada",
        tipoEntidade: "campanha",
        entidadeId: campanhaId,
        entidadeRotulo: dados.nome,
        ip,
        detalhes: {
          agendadaPara: dados.agendadaPara,
          totalMensagens: elegiveis * dados.sequencia.length,
        },
      });
    }

    return paraResumoCampanha(
      (await this.linha(campanhaId)) ?? ({ id: campanhaId } as LinhaCampanha),
    );
  }

  /**
   * Copia a campanha inteira — texto, canais, intervalos e PÚBLICO — em rascunho.
   *
   * Faltava e não tinha substituto: repetir um disparo para a mesma lista
   * obrigava a reimportar a planilha, e quem não a tivesse mais em mãos não
   * tinha caminho nenhum — o público vive dentro da campanha desde a migration
   * `20260815000500` e não há tela que o exporte de volta.
   *
   * Nasce SEMPRE em rascunho, nunca herda o agendamento e nunca enfileira
   * nada. Duplicar é um clique, e um clique que começa a disparar para vinte
   * mil pessoas é o tipo de acidente que não tem desfazer: a mensagem já saiu.
   * Quem quiser disparar clica "Retomar" depois, com o texto na frente.
   *
   * O público volta pela mesma RPC de `criar`, e não por um `insert ... select`
   * que copiaria as linhas direto: a RPC reaplica o filtro de opt-out. Quem
   * pediu para sair DEPOIS do disparo original não pode reaparecer numa cópia
   * feita hoje — seria justamente a segunda mensagem que ele proibiu.
   *
   * As métricas não vêm junto por serem da execução, não da campanha: enviadas,
   * lidas e respostas pertencem ao disparo que aconteceu, e uma cópia que
   * nascesse com "40 lidas" mentiria no dashboard do primeiro dia.
   */
  async duplicar(usuario: UsuarioAutenticado, id: string, ip: string): Promise<ResumoCampanha> {
    const original = await this.obter(usuario, id);
    const nome = nomeDaCopia(original.nome);

    // O público ANTES do INSERT: falhar aqui não deixa campanha órfã para trás.
    const publico = await this.publicoDaCampanha(id);

    const { data, error } = await this.supabase
      .tabela("campanhas")
      .insert({
        nome,
        status: "rascunho",
        lista_id: null,
        empresa_id: empresaParaEscrita(usuario),
        sequencia: original.sequencia,
        intervalo_contatos_min: original.intervaloEntreContatos.minSegundos,
        intervalo_contatos_max: original.intervaloEntreContatos.maxSegundos,
        intervalo_mensagens_min: original.intervaloEntreMensagens.minSegundos,
        intervalo_mensagens_max: original.intervaloEntreMensagens.maxSegundos,
        validar_numeros: original.validarNumeros,
        agendada_para: null,
        template_principal: original.templatePrincipal,
        criada_por: usuario.id,
        iniciada_em: null,
      })
      .select("id")
      .single();

    if (error) throw new Error(`Falha ao duplicar campanha: ${error.message}`);
    const novaId = (data as { id: string }).id;

    /*
     * Canal desconectado NÃO barra a duplicação, ao contrário de `criar`.
     *
     * `exigirCanaisProntos` existe para impedir campanha que vai disparar por
     * um número fora do ar; um rascunho não dispara nada. Exigi-lo aqui faria
     * o botão falhar justamente no dia em que o QR caiu — que é quando o
     * operador está refazendo a campanha. A checagem acontece em "Retomar".
     */
    if (original.canaisIds.length > 0) await this.vincularCanais(novaId, original.canaisIds);

    let elegiveis = 0;
    if (publico.length > 0) {
      const { data: total, error: erroPopular } = await this.supabase.db.rpc(
        "popular_publico_da_campanha",
        { p_campanha_id: novaId, p_publico: publico },
      );
      if (erroPopular) {
        // A cópia sem público seria uma campanha que o operador acha pronta e
        // não dispara para ninguém. Melhor não deixá-la existir.
        await this.supabase.tabela("campanhas").delete().eq("id", novaId);
        throw new Error(`Falha ao copiar o público da campanha: ${erroPopular.message}`);
      }
      elegiveis = Number(total ?? 0);
    }

    await this.auditoria.registrar({
      usuarioId: usuario.id,
      usuarioNome: usuario.nome,
      acao: "campanha.duplicada",
      tipoEntidade: "campanha",
      entidadeId: novaId,
      entidadeRotulo: nome,
      ip,
      detalhes: {
        origem: id,
        contatosCopiados: publico.length,
        contatosElegiveis: elegiveis,
        canais: original.canaisIds.length,
      },
    });

    return paraResumoCampanha((await this.linha(novaId)) ?? ({ id: novaId } as LinhaCampanha));
  }

  /**
   * O público de uma campanha na forma que `popular_publico_da_campanha` come.
   *
   * Paginado pelo mesmo motivo do relatório: o PostgREST corta em mil linhas e
   * não avisa, e uma cópia silenciosamente truncada em mil contatos é pior do
   * que nenhuma cópia — o operador dispararia achando que alcançou a lista
   * inteira.
   *
   * O nome sai de `variaveis.nome` porque é lá que ele está: a RPC grava
   * `contato_id = null` e descarta o `nome` do payload (ver `mapeamentoPadrao`).
   */
  private async publicoDaCampanha(
    id: string,
  ): Promise<{ telefone: string; nome: string; variaveis: Record<string, string> }[]> {
    const tudo: { telefone: string; nome: string; variaveis: Record<string, string> }[] = [];

    for (let de = 0; ; de += PAGINA_RELATORIO) {
      const { data, error } = await this.supabase
        .tabela("campanha_contatos")
        .select("telefone, variaveis")
        .eq("campanha_id", id)
        .order("id")
        .range(de, de + PAGINA_RELATORIO - 1);

      if (error) throw new Error(`Falha ao ler o público da campanha: ${error.message}`);
      const lote = (data ?? []) as unknown as { telefone: string; variaveis: unknown }[];

      for (const linha of lote) {
        const vars = variaveis(linha.variaveis);
        tudo.push({ telefone: linha.telefone, nome: vars.nome ?? "", variaveis: vars });
      }

      if (lote.length < PAGINA_RELATORIO) return tudo;
    }
  }

  async pausar(usuario: UsuarioAutenticado, id: string, ip: string): Promise<ResumoCampanha> {
    const campanha = await this.obter(usuario, id);
    if (campanha.status !== "em_andamento" && campanha.status !== "agendada") {
      throw new ConflictException("Só é possível pausar campanha agendada ou em andamento.");
    }

    /**
     * Pausar não remove job da fila — invalida a rodada.
     *
     * O pg-boss só apaga job por id dele, e o código antigo passava o id da
     * CAMPANHA para `deleteJob`: não apagava nada e ainda registrava "jobs
     * cancelados" no log. Pior, os jobs de contato nunca eram tocados.
     *
     * Agora o contador de rodada sobe, todo job já enfileirado vira no-op ao
     * acordar, e os pendentes voltam a ser candidatos ao replanejamento. Uma
     * escrita, sem depender de a fila colaborar.
     */
    const { error } = await this.supabase.db.rpc("invalidar_rodada_campanha", {
      p_campanha_id: id,
    });
    if (error) {
      throw new ConflictException(
        `Não foi possível pausar com segurança: ${error.message}. ` +
          `A campanha continua em andamento — tente de novo.`,
      );
    }

    await this.supabase.tabela("campanhas").update({ status: "pausada" }).eq("id", id);

    /*
     * Zera as marcas de agendamento junto com a pausa.
     *
     * `fila_ate` aponta para o fim da fila que `invalidar_rodada_campanha`
     * acabou de aposentar — horas à frente numa campanha grande. Sem limpar,
     * retomar agendaria o primeiro contato para o horário em que a execução
     * anterior TERIA terminado, e o operador clicaria em "retomar" sem ver
     * nada acontecer pelo resto do dia.
     */
    await this.supabase.db.rpc("limpar_agendamento_da_campanha", { p_campanha_id: id });

    await this.auditoria.registrar({
      usuarioId: usuario.id,
      usuarioNome: usuario.nome,
      acao: "campanha.pausada",
      tipoEntidade: "campanha",
      entidadeId: id,
      entidadeRotulo: campanha.nome,
      ip,
      detalhes: { motivo: "solicitação do operador" },
    });

    return paraResumoCampanha((await this.linha(id))!);
  }

  async editar(
    usuario: UsuarioAutenticado,
    id: string,
    dados: CampanhaEdicao,
    ip: string,
  ): Promise<ResumoCampanha> {
    const campanha = await this.obter(usuario, id);
    const canaisMudaram =
      dados.canaisIds !== undefined &&
      [...dados.canaisIds].sort().join(",") !== [...campanha.canaisIds].sort().join(",");
    if (canaisMudaram) await this.exigirCanaisProntos(usuario, dados.canaisIds!);

    const ativa = campanha.status === "em_andamento" || campanha.status === "agendada";
    const agendamento = dados.agendadaPara !== undefined ? dados.agendadaPara : campanha.agendadaPara;
    if (ativa) {
      await this.supabase.db.rpc("invalidar_rodada_campanha", { p_campanha_id: id });
      await this.supabase.db.rpc("limpar_agendamento_da_campanha", { p_campanha_id: id });
    }

    const atualizacao: Record<string, unknown> = {};
    if (dados.nome !== undefined) atualizacao.nome = dados.nome;
    if (dados.sequencia !== undefined) {
      atualizacao.sequencia = dados.sequencia;
      atualizacao.template_principal = dados.sequencia[0]?.templateId ?? null;
    }
    if (dados.intervaloEntreContatos) {
      atualizacao.intervalo_contatos_min = dados.intervaloEntreContatos.minSegundos;
      atualizacao.intervalo_contatos_max = dados.intervaloEntreContatos.maxSegundos;
    }
    if (dados.intervaloEntreMensagens) {
      atualizacao.intervalo_mensagens_min = dados.intervaloEntreMensagens.minSegundos;
      atualizacao.intervalo_mensagens_max = dados.intervaloEntreMensagens.maxSegundos;
    }
    if (dados.validarNumeros !== undefined) atualizacao.validar_numeros = dados.validarNumeros;
    if (dados.agendadaPara !== undefined) {
      atualizacao.agendada_para = dados.agendadaPara;
      atualizacao.status = dados.agendadaPara ? "agendada" : "em_andamento";
      atualizacao.iniciada_em = dados.agendadaPara
        ? null
        : campanha.iniciadaEm ?? new Date().toISOString();
    }

    if (Object.keys(atualizacao).length > 0) {
      const { error } = await noEscopo(
        this.supabase.tabela("campanhas").update(atualizacao).eq("id", id),
        usuario,
      );
      if (error) throw new Error(`Falha ao editar campanha: ${error.message}`);
    }

    if (dados.canaisIds) {
      const { error: erroRemover } = await this.supabase
        .tabela("campanha_canais")
        .delete()
        .eq("campanha_id", id);
      if (erroRemover) throw new Error(`Falha ao atualizar canais: ${erroRemover.message}`);
      await this.vincularCanais(id, dados.canaisIds);
    }

    if (ativa) {
      await this.fila.agendarCampanha({ campanhaId: id, rodada: await this.rodadaAtual(id) }, agendamento);
    }

    await this.auditoria.registrar({
      usuarioId: usuario.id,
      usuarioNome: usuario.nome,
      acao: "campanha.editada",
      tipoEntidade: "campanha",
      entidadeId: id,
      entidadeRotulo: dados.nome ?? campanha.nome,
      ip,
      detalhes: { campos: Object.keys(dados) },
    });

    return paraResumoCampanha((await this.linha(id))!);
  }

  async excluir(usuario: UsuarioAutenticado, id: string, ip: string): Promise<string> {
    const campanha = await this.obter(usuario, id);
    const ativa = campanha.status === "em_andamento" || campanha.status === "agendada";
    if (ativa) await this.supabase.db.rpc("invalidar_rodada_campanha", { p_campanha_id: id });

    await this.auditoria.registrar({
      usuarioId: usuario.id,
      usuarioNome: usuario.nome,
      acao: "campanha.excluida",
      tipoEntidade: "campanha",
      entidadeId: id,
      entidadeRotulo: campanha.nome,
      ip,
      detalhes: { status: campanha.status },
    });

    const { error } = await noEscopo(
      this.supabase.tabela("campanhas").delete().eq("id", id),
      usuario,
    );
    if (error) throw new Error(`Falha ao excluir campanha: ${error.message}`);
    return id;
  }

  /** Retoma de onde parou: os contatos já enviados continuam marcados. */
  async retomar(usuario: UsuarioAutenticado, id: string, ip: string): Promise<ResumoCampanha> {
    const campanha = await this.obter(usuario, id);
    /**
     * `pausada_por_canal` entra aqui junto com `pausada`.
     *
     * Sem isso, campanha pausada pelo sistema (canal caiu, gateway fora do ar)
     * ficaria sem nenhum caminho de retomada pelo produto: o operador reconecta
     * o QR e não teria botão nenhum para seguir. O `exigirCanaisProntos` abaixo
     * é o que impede retomar antes de o canal voltar de verdade.
     */
    const retomaveis = ["pausada", "pausada_por_canal", "rascunho"];
    if (!retomaveis.includes(campanha.status)) {
      throw new ConflictException("Só é possível retomar campanha pausada ou em rascunho.");
    }
    await this.exigirCanaisProntos(usuario, campanha.canaisIds);

    /*
     * Retomar ocupa uma vaga de campanha simultânea igual a criar: uma
     * campanha em rascunho retomada é trabalho novo na fila compartilhada.
     *
     * `usuario.empresaId` direto, e NÃO `empresaParaEscrita`: aquela função
     * LANÇA para a conta global, e a conta global sempre pôde retomar campanha
     * de qualquer cliente — é o acesso de suporte. Trocar por ela transformaria
     * "conferir um limite" em "tirar o suporte do ar", que é um estrago maior
     * que o limite evita.
     */
    if (usuario.empresaId !== null) {
      await this.limites.exigirEspacoParaCampanha(usuario.empresaId);
    }

    // Ver o comentário em `pausar`: a fila anterior foi aposentada e
    // `fila_ate` não pode continuar apontando para o fim dela.
    await this.supabase.db.rpc("limpar_agendamento_da_campanha", { p_campanha_id: id });

    await this.supabase
      .tabela("campanhas")
      .update({
        status: "em_andamento",
        iniciada_em: campanha.iniciadaEm ?? new Date().toISOString(),
        // Limpa a marca da pausa automática: se não zerar, o watchdog pode
        // reconsiderar esta campanha como "pausada por aquele canal" depois.
        pausada_por_canal_id: null,
        pausada_motivo: null,
      })
      .eq("id", id);

    // A rodada atual é a que o pause deixou; o planejamento carimba os jobs
    // novos com ela, e os antigos (rodada anterior) morrem ao acordar.
    await this.fila.agendarCampanha({ campanhaId: id, rodada: await this.rodadaAtual(id) }, null);

    await this.auditoria.registrar({
      usuarioId: usuario.id,
      usuarioNome: usuario.nome,
      acao: "campanha.iniciada",
      tipoEntidade: "campanha",
      entidadeId: id,
      entidadeRotulo: campanha.nome,
      ip,
      detalhes: { retomada: true },
    });

    return paraResumoCampanha((await this.linha(id))!);
  }

  // ------------------------------------------------------------------------
  // Apoio
  // ------------------------------------------------------------------------

  private async linha(id: string): Promise<LinhaCampanha | null> {
    const { data } = await this.supabase
      .tabela("campanhas")
      .select(COLUNAS_CAMPANHA)
      .eq("id", id)
      .maybeSingle();
    return (data as unknown as LinhaCampanha) ?? null;
  }

  /**
   * Geração atual da execução, para carimbar os jobs novos.
   *
   * Lida na hora de enfileirar, e não guardada em memória: entre pausar e
   * retomar pode ter passado um dia e outro processo pode ter mexido nela.
   */
  private async rodadaAtual(id: string): Promise<number> {
    const { data } = await this.supabase
      .tabela("campanhas")
      .select("rodada")
      .eq("id", id)
      .maybeSingle();
    return (data as { rodada: number | null } | null)?.rodada ?? 0;
  }

  /** Canal precisa existir, estar conectado e ser acessível ao usuário. */
  private async exigirCanaisProntos(
    usuario: UsuarioAutenticado,
    canaisIds: string[],
  ): Promise<void> {
    for (const id of canaisIds) await this.canais.exigirAcesso(usuario, id);

    const { data, error } = await this.supabase
      .tabela("canais")
      .select("id, nome, status")
      .in("id", canaisIds);

    if (error) throw new Error(`Falha ao verificar canais: ${error.message}`);

    const encontrados = (data ?? []) as { id: string; nome: string; status: string }[];
    const problemas = canaisIds
      .map((id) => encontrados.find((c) => c.id === id))
      .filter((c) => !c || c.status !== "conectado");

    if (problemas.length > 0) {
      // Disparar por canal caído falha contato a contato — melhor barrar aqui.
      const nomes = problemas.map((c) => c?.nome ?? "canal removido").join(", ");
      throw new ConflictException(`Canal indisponível ou desconectado: ${nomes}.`);
    }
  }

  private async vincularCanais(campanhaId: string, canaisIds: string[]): Promise<void> {
    const { error } = await this.supabase
      .tabela("campanha_canais")
      .insert(canaisIds.map((canal_id) => ({ campanha_id: campanhaId, canal_id })));
    if (error) throw new Error(`Falha ao vincular canais: ${error.message}`);
  }
}

/**
 * "Campanha X" -> "Campanha X (cópia)", e a cópia da cópia não vira
 * "(cópia) (cópia)" — vira "(cópia 2)".
 *
 * O corte respeita `maxCaracteresNomeCampanha`: a coluna tem limite e um nome
 * comprido duplicado duas vezes estouraria o INSERT com erro de banco cru na
 * cara do operador. O sufixo é o que sobrevive ao corte, porque é ele que
 * distingue a cópia do original na lista.
 */
export function nomeDaCopia(nome: string): string {
  const m = /^(.*) \(cópia(?: (\d+))?\)$/.exec(nome.trim());
  const raiz = m ? m[1] : nome.trim();
  const proxima = m ? Number(m[2] ?? 1) + 1 : 1;
  const sufixo = proxima === 1 ? " (cópia)" : ` (cópia ${proxima})`;
  const espaco = LIMITES.maxCaracteresNomeCampanha - sufixo.length;
  return `${raiz.slice(0, Math.max(espaco, 1)).trimEnd()}${sufixo}`;
}
