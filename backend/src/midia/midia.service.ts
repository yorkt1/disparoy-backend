import { BadRequestException, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { MIDIA_ACEITA, tipoDaExtensao, type TipoMidia } from "@disparoy/dominio";
import { SupabaseService } from "../supabase/supabase.service";
import { AuditoriaService } from "../auditoria/auditoria.service";
import { ambiente } from "../config/ambiente";
import type { UsuarioAutenticado } from "../auth/auth.guard";

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

    // O mime declarado pelo navegador não decide nada sozinho — é conferido
    // contra a extensão, que é o que define o `mediatype` no envio.
    if (arquivo.mimetype && !(regra.mimes as readonly string[]).includes(arquivo.mimetype)) {
      throw new BadRequestException(
        `O conteúdo do arquivo (${arquivo.mimetype}) não bate com a extensão ${extensao}.`,
      );
    }

    const caminho = `campanhas/${randomUUID()}${extensao}`;

    const { error } = await this.supabase.db.storage
      .from(BUCKET_MIDIA)
      .upload(caminho, arquivo.buffer, {
        contentType: arquivo.mimetype || undefined,
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
      entidadeRotulo: arquivo.originalname,
      ip,
      detalhes: { tipo, tamanho: arquivo.size },
    });

    return { url, tipo, nomeArquivo: arquivo.originalname, tamanho: arquivo.size };
  }
}
