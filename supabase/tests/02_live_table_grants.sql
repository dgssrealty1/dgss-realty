-- TEST-ONLY: the grants the LIVE project has on the original five tables
-- (observed 2026-10-03). Run right after schema.sql.
do $$ declare t text; begin
  foreach t in array array['properties','property_images','leads','testimonials','settings'] loop
    execute format('revoke all on public.%I from anon, authenticated, service_role', t);
    execute format('grant select, truncate, references, trigger on public.%I to anon', t);
    execute format('grant select, insert, update, delete, truncate, references, trigger on public.%I to authenticated', t);
    execute format('grant truncate, references, trigger on public.%I to service_role', t);
  end loop;
end $$;
