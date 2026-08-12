import { Injectable } from "@nestjs/common";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ambiente } from "../config/ambiente";

/**
 * Acesso ao Supabase com a service role.
 *
 * Essa chave ignora RLS, então TODA consulta feita por aqui precisa filtrar
 * o papel do usuário explicitamente. O RLS segue valendo como rede de segurança
 * para quem acessa o banco direto com a anon key, mas não protege esta camada.
 */
@Injectable()
export class SupabaseService {
  private readonly cliente: SupabaseClient;

  constructor() {
    const env = ambiente();
    this.cliente = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  get db(): SupabaseClient {
    return this.cliente;
  }

  /** Tabela já tipada como `any` do supabase-js; o tipo real vem dos mapeadores. */
  tabela(nome: string) {
    return this.cliente.from(nome);
  }
}
