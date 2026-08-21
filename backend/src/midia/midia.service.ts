import { BadRequestException, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { MIDIA_ACEITA, tipoDaExtensao, type TipoMidia } from "@disparoy/dominio";
import { SupabaseService } from "../supabase/supabase.service";
import { AuditoriaService } from "../auditoria/auditoria.service";
import { ambiente } from "../config/ambiente";
import type { UsuarioAutenticado } from "../auth/auth.guard";
import { conferirConteudo, nomeExibivel } from "./assinatura";

/** Bucket público criado para as mídias das campanhas. */
export const BUCKET_MIDIA = "midia";

export interface MidiaEnviada {
  url: string;
  tipo: TipoMidia;
  nomeArquivo: string;
  tamanho: number;
}

/**
 * Upload de mídia para o Supabase Storage.
 *
 * O bucket é PÚBLICO de propósito: quem baixa o arquivo é o servidor do
 * WhatsApp, não o navegador do operador. URL assinada expiraria no meio de uma
 * campanha de 25 horas e as últimas mensagens sairiam com mídia quebrada.
 *
 * O nome do arquivo no bucket é um uuid, não o nome original: dois operadores
 * subindo "banner.jpg" não podem se sobrescrever, e o nome original costuma
 * carregar acento, espaço e caminho do Windows.
 */
@Injectable()
export class MidiaService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly auditoria: AuditoriaService,
  ) {}

  async enviar(
    usuario: UsuarioAutenticado,
    arquivo: Express.Multer.File,
    ip: string,
  ): Promise<MidiaEnviada> {
    const ponto = arquivo.originalname.lastIndexOf(".");
    const extensao = ponto >= 0 ? arquivo.originalname.slice(ponto).toLowerCase() : "";

    const tipo = tipoDaExtensao(extensao);
    if (!tipo) {
      throw new BadRequestException(
        `Formato não aceito${extensao ? ` (${extensao})` : ""}. ` +
          `Aceitos: ${Object.values(MIDIA_ACEITA).flatMap((m) => m.extensoes).join(", ")}.`,
      );
    }

    const regra = MIDIA_ACEITA[tipo];
    if (arquivo.size > regra.maxBytes) {
      throw new BadRequestException(
        `${tipo} pode ter no máximo ${Math.round(regra.maxBytes / 1024 / 1024)} MB ` +
          `(o WhatsApp recusa acima disso). Este tem ${(arquivo.size / 1024 / 1024).toFixed(1)} MB.`,
      );
    }

    /*
     * Quem decide é o conteúdo, não o cabeçalho.
     *
     * A conferência anterior comparava `arquivo.mimetype` — o `Content-Type`
     * que o próprio cliente escreveu na parte do multipart — com a lista da
     * extensão. Duas strings do mesmo remetente concordando entre si não provam
     * nada, e o `if (arquivo.mimetype)` ainda deixava a checagem inteira ser
     * pulada mandando a parte sem tipo declarado. Como o bucket é público e a
     * URL é permanente, o que passasse por aqui viraria arquivo hospedado
     * indefinidamente no domínio do projeto.
     *
     * O mime devolvido é derivado da EXTENSÃO já validada, e é ele que vai para
     * o Storage: gravar o do cliente deixaria quem sobe o arquivo escolher como
     * o navegador de terceiros vai interpretá-lo depois.
     */
    const veredito = conferirConteudo(arquivo.buffer, extensao);
    if (!veredito.ok) throw new BadRequestException(veredito.motivo);

    const nomeArquivo = nomeExibivel(arquivo.originalname, extensao);
    const caminho = `campanhas/${randomUUID()}${extensao}`;

    const { error } = await this.supabase.db.storage
      .from(BUCKET_MIDIA)
      .upload(caminho, arquivo.buffer, {
        contentType: veredito.mime,
        // Caminho é uuid: colisão significaria bug, não sobrescrita legítima.
        upsert: false,
      });

    if (error) throw new BadRequestException(`Falha ao enviar o arquivo: ${error.message}`);

    const url = `${ambiente().SUPABASE_URL.replace(/\/+$/, "")}/storage/v1/object/public/${BUCKET_MIDIA}/${caminho}`;

    await this.auditoria.registrar({
      usuarioId: usuario.id,
      usuarioNome: usuario.nome,
      acao: "midia.upload",
      tipoEntidade: "midia",
      entidadeId: caminho,
      entidadeRotulo: nomeArquivo,
      ip,
      detalhes: { tipo, tamanho: arquivo.size, mime: veredito.mime },
    });

    return { url, tipo, nomeArquivo, tamanho: arquivo.size };
  }
}
