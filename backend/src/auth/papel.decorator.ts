import { SetMetadata } from "@nestjs/common";
import type { Papel } from "@disparoy/dominio";

export const PAPEIS_EXIGIDOS = "papeis_exigidos";

/**
 * Restringe a rota aos papéis informados. Verificado no `AuthGuard`, depois de
 * o perfil ser lido do banco — nunca a partir do token.
 */
export const ExigePapel = (...papeis: Papel[]) => SetMetadata(PAPEIS_EXIGIDOS, papeis);

/** Atalho para o caso mais comum: só administradores. */
export const SomenteAdmin = () => ExigePapel("admin");
