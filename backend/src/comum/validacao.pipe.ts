import { BadRequestException, PipeTransform } from "@nestjs/common";
import { z, type ZodTypeAny } from "zod";
import { achatarErros } from "@disparoy/dominio";

/**
 * Valida o corpo com um schema Zod do pacote de domínio.
 *
 * Usa os MESMOS schemas do frontend, então uma regra de negócio não pode
 * divergir entre as duas pontas — o cliente valida para dar feedback rápido,
 * a API valida porque nada que vem do cliente é confiável.
 */
export class ValidacaoZodPipe<T extends ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(valor: unknown): z.infer<T> {
    const resultado = this.schema.safeParse(valor);
    if (!resultado.success) {
      throw new BadRequestException({
        statusCode: 400,
        erro: "Dados inválidos.",
        erros: achatarErros(resultado.error),
      });
    }
    return resultado.data;
  }
}
