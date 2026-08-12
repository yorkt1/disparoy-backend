import { Global, Module } from "@nestjs/common";
import { SupabaseService } from "./supabase.service";

/** Global: praticamente todo módulo precisa do cliente. */
@Global()
@Module({
  providers: [SupabaseService],
  exports: [SupabaseService],
})
export class SupabaseModule {}
