import { BadRequestException } from "@nestjs/common";
import type { UsuarioAutenticado } from "../auth/auth.guard";

/**
 * O escopo de empresa, em um lugar só.
 *
 * A API roda com a service role e ignora RLS: o filtro por empresa feito aqui
 * NÃO tem segunda linha de defesa no banco. Ele é a defesa. Por isso existe
 * como função compartilhada em vez de um `.eq("empresa_id", ...)` repetido em
 * cada serviço — seis cópias da mesma regra divergem, e a que divergir vira o
 * vazamento entre clientes.
 *
 * A conta de administração (`empresaId === null`) atravessa todas as empresas
 * de propósito: é o acesso global de suporte.
 */

/**
 * Restringe uma consulta à empresa do usuário.
 *
 * O genérico é livre — `<T>` e não `<T extends Filtravel<T>>` — porque a
 * restrição recursiva, aplicada aos tipos já profundos do supabase-js, faz o
 * TypeScript desistir com "type instantiation is excessively deep". O preço é
 * o cast abaixo, que fica CONTIDO nesta função: os serviços chamam
 * `noEscopo(...)` e seguem encadeando com o tipo original preservado.
 */
export function noEscopo<T>(consulta: T, usuario: UsuarioAutenticado): T {
  if (usuario.empresaId === null) return consulta;
  return (consulta as { eq(coluna: string, valor: string): T }).eq(
    "empresa_id",
    usuario.empresaId,
  );
}

/**
 * A empresa a gravar em toda escrita.
 *
 * Recusa a conta global em vez de escolher uma empresa por ela. Um admin sem
 * empresa criando um contato não tem dono possível, e qualquer palpite —
 * a empresa padrão, a primeira da lista — recria exatamente o problema que esta
 * camada existe para resolver: dado de cliente numa empresa que não é a dele.
 *
 * Falhar aqui é barulhento e cedo; o palpite seria silencioso e permanente.
 */
export function empresaParaEscrita(usuario: UsuarioAutenticado): string {
  if (usuario.empresaId === null) {
    throw new BadRequestException(
      "Esta conta é global e não está vinculada a uma empresa. " +
        "Entre com o acesso da empresa para criar ou importar dados.",
    );
  }
  return usuario.empresaId;
}
