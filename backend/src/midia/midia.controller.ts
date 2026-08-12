import { Controller, HttpStatus, ParseFilePipeBuilder, Post, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { MAX_BYTES_MIDIA } from "@disparoy/dominio";
import { IpOrigem, Usuario } from "../auth/usuario.decorator";
import type { UsuarioAutenticado } from "../auth/auth.guard";
import { MidiaService } from "./midia.service";

@Controller("midia")
export class MidiaController {
  constructor(private readonly midia: MidiaService) {}

  /**
   * Sobe um arquivo do computador e devolve a URL pública.
   *
   * O teto do interceptor é o maior de todos os tipos; o limite específico de
   * cada um é conferido no serviço, que já sabe se é imagem ou documento.
   */
  @Post()
  @UseInterceptors(FileInterceptor("arquivo", { limits: { fileSize: MAX_BYTES_MIDIA } }))
  async enviar(
    @Usuario() usuario: UsuarioAutenticado,
    @UploadedFile(
      new ParseFilePipeBuilder()
        .addMaxSizeValidator({ maxSize: MAX_BYTES_MIDIA })
        .build({ errorHttpStatusCode: HttpStatus.PAYLOAD_TOO_LARGE, fileIsRequired: true }),
    )
    arquivo: Express.Multer.File,
    @IpOrigem() ip: string,
  ) {
    return { midia: await this.midia.enviar(usuario, arquivo, ip) };
  }
}
