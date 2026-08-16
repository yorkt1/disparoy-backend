import { z } from "zod";
import { LIMITES, ORIGENS_OPT_IN } from "./config.js";

/**
 * Schemas de fronteira, compartilhados por API e frontend.
 *
 * O cliente valida para dar feedback rápido; a API valida porque nada que vem
 * do cliente é confiável. Usar o MESMO schema nos dois lados é o que impede
 * uma regra de negócio de divergir entre as pontas.
 */

const ORIGENS = ORIGENS_OPT_IN.map((o) => o.valor) as [string, ...string[]];

export const intervaloSchema = z
  .object({
    minSegundos: z.number().int().min(0).max(3600),
    maxSegundos: z.number().int().min(0).max(3600),
  })
  .refine((v) => v.maxSegundos >= v.minSegundos, {
    message: "O intervalo máximo deve ser maior ou igual ao mínimo.",
    path: ["maxSegundos"],
  });

export const mensagemSequenciaSchema = z.object({
  id: z.string().min(1),
  tipo: z.enum(["texto", "midia"]),
  corpo: z.string().max(LIMITES.maxCaracteresMensagem),
  templateId: z.string().optional(),
  midia: z
    .object({
      tipo: z.enum(["imagem", "video", "documento", "audio"]),
      url: z.string().url(),
      nomeArquivo: z.string().min(1).max(255),
    })
    .optional(),
});

// --------------------------------------------------------------------------
// Contatos e listas
// --------------------------------------------------------------------------

/**
 * Consentimento é obrigatório na importação — não é caixinha opcional.
 *
 * A LGPD exige base legal registrada ANTES do tratamento; deixar o operador
 * importar "para decidir depois" cria justamente a base sem prova que a lei
 * proíbe usar.
 */
export const consentimentoSchema = z.object({
  origem: z.enum(ORIGENS, {
    errorMap: () => ({ message: "Informe como o consentimento foi obtido." }),
  }),
  /** Data em que o contato consentiu; não pode estar no futuro. */
  obtidoEm: z
    .string()
    .datetime({ offset: true })
    .refine((v) => new Date(v).getTime() <= Date.now() + 60_000, {
      message: "A data do consentimento não pode estar no futuro.",
    }),
  confirmacao: z.literal(true, {
    errorMap: () => ({
      message: "Confirme que possui prova do consentimento destes contatos.",
    }),
  }),
});

export const contatoImportadoSchema = z.object({
  telefone: z.string().max(20),
  telefoneOriginal: z.string().max(64),
  nome: z.string().max(120).nullable().default(null),
  valido: z.boolean(),
  motivoInvalido: z.string().max(120).optional(),
  variaveis: z.record(z.string().max(500)).default({}),
});

export const importacaoContatosSchema = z.object({
  contatos: z
    .array(contatoImportadoSchema)
    .min(1, "Nenhum contato para importar.")
    .max(LIMITES.maxContatosPorImportacao),
  consentimento: consentimentoSchema,
  /** Adiciona os importados a uma lista existente… */
  listaId: z.string().uuid().optional(),
  /** …ou cria uma nova com este nome. */
  novaLista: z.string().trim().min(2).max(80).optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(20).default([]),
});

export const listaEntradaSchema = z.object({
  nome: z.string().trim().min(2).max(80),
  descricao: z.string().trim().max(300).nullable().default(null),
});

export const optOutManualSchema = z.object({
  motivo: z.string().trim().max(200).default("Solicitação registrada pelo operador"),
});

// --------------------------------------------------------------------------
// Campanhas
// --------------------------------------------------------------------------

export const campanhaEntradaSchema = z
  .object({
    nome: z.string().trim().min(3).max(LIMITES.maxCaracteresNomeCampanha),
    /**
     * O público vive DENTRO da campanha.
     *
     * Substituiu `listaId`: não existe mais cadastro de contatos, e a lista de
     * destino chega por planilha ou colagem no momento de criar. O telefone já
     * vem normalizado em E.164 pelo domínio, dos dois lados.
     */
    publico: z
      .array(
        z.object({
          telefone: z.string().regex(/^\+[1-9][0-9]{7,14}$/, "Telefone inválido."),
          nome: z.string().trim().max(120).default(""),
          variaveis: z.record(z.string()).default({}),
        }),
      )
      .min(1, "Adicione ao menos um contato à campanha.")
      .max(LIMITES.maxContatosPorImportacao),
    canaisIds: z.array(z.string().uuid()).min(1, "Selecione ao menos um canal."),
    sequencia: z
      .array(mensagemSequenciaSchema)
      .min(1, "A sequência precisa de ao menos uma mensagem.")
      .max(LIMITES.maxMensagensPorContato),
    intervaloEntreContatos: intervaloSchema,
    intervaloEntreMensagens: intervaloSchema,
    validarNumeros: z.boolean().default(true),
    agendadaPara: z.string().datetime({ offset: true }).nullable().default(null),
    acao: z.enum(["disparar", "rascunho"]).default("rascunho"),
  })
  .superRefine((v, ctx) => {
    if (v.acao !== "disparar") return;

    v.sequencia.forEach((m, i) => {
      if (m.tipo === "texto" && !m.corpo.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sequencia", i, "corpo"],
          message: `A mensagem ${i + 1} está vazia.`,
        });
      }
      if (m.tipo === "midia" && !m.midia) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sequencia", i, "midia"],
          message: `A mensagem ${i + 1} é de mídia mas nenhum arquivo foi anexado.`,
        });
      }
    });

    if (v.agendadaPara && new Date(v.agendadaPara).getTime() < Date.now() - 60_000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["agendadaPara"],
        message: "A data de agendamento já passou.",
      });
    }
  });

export type CampanhaEntrada = z.infer<typeof campanhaEntradaSchema>;

// --------------------------------------------------------------------------
// Spintax, canais, templates, usuários
// --------------------------------------------------------------------------

export const spintaxEntradaSchema = z.object({
  nome: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9_]+$/i, "Use apenas letras, números e underline."),
  opcoes: z
    .array(z.string().trim().min(1).max(1000))
    .min(2, "Uma variação precisa de ao menos duas opções.")
    .max(50),
});

/**
 * Geração de variações a partir do texto original.
 *
 * `quantidade` conta o total COM o original incluído, porque é assim que o
 * operador enxerga a lista: pedir "5 variações" e receber 6 opções na tela
 * seria uma surpresa a cada uso.
 */
export const geracaoVariacoesSchema = z.object({
  texto: z
    .string()
    .trim()
    .min(10, "Escreva o texto original antes de gerar as variações.")
    .max(LIMITES.maxCaracteresMensagem),
  quantidade: z.number().int().min(2).max(10).default(5),
});

/**
 * Criar canal pede só o nome.
 *
 * `numero` não entra: quem define o número é o aparelho que escaneia o QR, e
 * digitá-lo antes só criava um rótulo que ninguém conferia. Ele chega pelo
 * webhook, quando o pareamento acontece.
 *
 * `tipoConexao` também não: por ora todo canal é QR Code. A coluna e o tipo
 * continuam existindo para quando a API Oficial voltar ao escopo.
 */
/**
 * Pareamento por código exige o número; por QR, não.
 *
 * O `superRefine` amarra os dois campos em vez de deixar `numero` opcional
 * solto: escolher "código" e não informar o número faria a Evolution devolver
 * um 400 genérico já com o canal criado no banco — sobrando um canal órfão que
 * ninguém consegue parear.
 */
export const canalEntradaSchema = z
  .object({
    nome: z.string().trim().min(2).max(60),
    /** `null` = sem teto diário, que é o padrão agora. */
    limiteDiario: z.number().int().min(1).max(100_000).nullable().default(null),
    estagioAquecimento: z.number().int().min(0).max(3).default(0),
    metodoPareamento: z.enum(["qrcode", "codigo"]).default("qrcode"),
    /** E.164 do celular que vai parear. Só no método `codigo`. */
    numeroPareamento: z.string().trim().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.metodoPareamento !== "codigo") return;
    if (!v.numeroPareamento) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["numeroPareamento"],
        message: "Informe o número do WhatsApp que vai parear.",
      });
    }
  });

/**
 * Reconexão: mesmo par de campos da criação, sem os dados do canal.
 *
 * Existe separado porque o método pode MUDAR entre uma tentativa e outra —
 * quem tentou pelo QR e não tinha uma segunda tela troca para o código aqui.
 */
export const reconexaoCanalSchema = z
  .object({
    metodoPareamento: z.enum(["qrcode", "codigo"]).default("qrcode"),
    numeroPareamento: z.string().trim().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.metodoPareamento === "codigo" && !v.numeroPareamento) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["numeroPareamento"],
        message: "Informe o número do WhatsApp que vai parear.",
      });
    }
  });

export const canalAjusteSchema = z.object({
  limiteDiario: z.number().int().min(1).max(100_000).optional(),
  estagioAquecimento: z.number().int().min(0).max(3).optional(),
  status: z.enum(["conectado", "desconectado"]).optional(),
});

export const membroCanalSchema = z.object({
  perfilId: z.string().uuid(),
  permissao: z.enum(["owner", "operator", "viewer"]).default("operator"),
});

export const templateEntradaSchema = z.object({
  nome: z
    .string()
    .trim()
    .min(3)
    .max(60)
    .regex(/^[a-z0-9_]+$/, "O nome deve seguir o padrão da Meta: minúsculas e underline."),
  categoria: z.enum(["marketing", "utilidade", "autenticacao"]),
  idioma: z.string().trim().min(2).max(10).default("pt_BR"),
  corpo: z.string().trim().min(1).max(1024),
});

/**
 * Sistema interno: não existe auto-cadastro nem convite por e-mail. O admin
 * cria o acesso já com a senha e entrega ao operador — assim a instalação não
 * depende de SMTP configurado, que numa rede interna costuma não existir.
 */
export const senhaSchema = z
  .string()
  .min(6, "A senha precisa de pelo menos 6 caracteres.")
  // 6 é o mínimo do próprio Supabase Auth: exigir mais aqui só produziria uma
  // senha aceita na tela e recusada pelo Auth, ou o contrário.
  .max(72, "A senha não pode passar de 72 caracteres.");

export const loginSchema = z.object({
  email: z.string().trim().email("Informe um e-mail válido."),
  senha: z.string().min(1, "Informe a senha."),
});

export const novoUsuarioSchema = z.object({
  nome: z.string().trim().min(2).max(120),
  email: z.string().trim().email(),
  senha: senhaSchema,
  papel: z.enum(["admin", "operator"]).default("operator"),
  /**
   * A empresa do novo acesso. Só a conta de administração pode escolher.
   *
   * `null` cria outro acesso GLOBAL — é assim que nasce um segundo
   * administrador de sistema. Quando quem cria pertence a uma empresa, este
   * campo é ignorado e o acesso herda a empresa dele.
   */
  empresaId: z.string().uuid().nullable().optional(),
});

/**
 * `senha` aqui é a redefinição feita pelo admin.
 *
 * Sem envio de e-mail não há "esqueci minha senha": quem perde o acesso
 * depende do admin trocar a senha por ele, senão fica trancado para sempre.
 */
export const ajusteUsuarioSchema = z
  .object({
    papel: z.enum(["admin", "operator"]).optional(),
    ativo: z.boolean().optional(),
    senha: senhaSchema.optional(),
  })
  .refine((v) => Object.values(v).some((c) => c !== undefined), {
    message: "Informe ao menos um campo para alterar.",
  });

/** Achata erros do Zod em { campo: mensagem } para exibição no formulário. */
export function achatarErros(erro: z.ZodError): Record<string, string> {
  const saida: Record<string, string> = {};
  for (const issue of erro.issues) {
    const chave = issue.path.join(".") || "_";
    if (!saida[chave]) saida[chave] = issue.message;
  }
  return saida;
}
