import { SetMetadata } from "@nestjs/common";

export const ROTA_PUBLICA = "rota_publica";

/**
 * Dispensa autenticação na rota. Usado só por health check e pelo webhook da
 * Meta, que se autentica por assinatura própria e não tem sessão de usuário.
 */
export const Publico = () => SetMetadata(ROTA_PUBLICA, true);
