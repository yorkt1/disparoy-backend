-- ============================================================================
-- O número do canal deixa de ser digitado e passa a ser descoberto.
--
-- Ele nunca serviu para conectar nada: `instance/create` recebe só o nome da
-- instância, e quem define o número é o aparelho que escaneia o QR. O que se
-- digitava era um rótulo que ninguém conferia — dava para cadastrar um número
-- e parear outro, e o painel (e a auditoria) mostrariam o errado para sempre.
--
-- Agora nasce nulo e é preenchido pelo webhook CONNECTION_UPDATE, a partir do
-- `ownerJid` que a Evolution reporta. Passa a ser fato, não digitação.
-- ============================================================================

alter table canais alter column numero drop not null;

-- O `unique` da coluna não convive com vários canais aguardando pareamento:
-- em Postgres NULLs não colidem entre si, mas a constraint some junto com a
-- coluna obrigatória, então recriamos como índice parcial explícito.
do $$
declare
  r record;
begin
  for r in
    select con.conname
    from pg_constraint con
    join pg_class cl on cl.oid = con.conrelid
    where cl.relname = 'canais'
      and con.contype = 'u'
      and con.conkey = array[
        (select attnum from pg_attribute
          where attrelid = 'public.canais'::regclass and attname = 'numero')
      ]
  loop
    execute format('alter table canais drop constraint %I', r.conname);
  end loop;
end;
$$;

-- Dois canais não podem apontar para o mesmo WhatsApp; vários podem estar
-- esperando pareamento ao mesmo tempo.
create unique index if not exists canais_numero_unico
  on canais (numero)
  where numero is not null;
