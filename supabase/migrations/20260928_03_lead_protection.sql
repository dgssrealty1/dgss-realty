-- =====================================================================
-- MIGRATION 03 — Lead protection + lead tracking
-- ---------------------------------------------------------------------
-- BEFORE: anyone holding the public anon key could INSERT any row into
--   leads directly — any length, any content, unlimited times, with any
--   property title typed in by the client.
--
-- AFTER:  direct INSERT is removed. The ONLY public way in is
--   public.submit_lead(...), a SECURITY DEFINER function that
--     * whitelists the source (form type) and derives lead_type
--     * validates name / phone / email / message lengths and formats
--     * resolves property_id itself and takes the title snapshot from
--       the database (never trusts client-supplied titles)
--     * silently drops honeypot submissions
--     * de-duplicates double submits (same phone + form + property
--       within 10 minutes)
--     * rate-limits per phone, per client IP and globally
--     * optionally requires a shared "gate" secret so that only the
--       site's own Worker (which also checks Cloudflare Turnstile) can
--       submit — see private.app_secrets below
--
-- Adds: leads.lead_type, leads.client_ip_hash (a salted hash — the raw
-- IP is never stored), indexes for rate limiting and property lookups.
-- Safe to re-run.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------
alter table public.leads add column if not exists lead_type text;
alter table public.leads add column if not exists client_ip_hash text;

comment on column public.leads.lead_type is
  'buyer_enquiry | seller_lead | joint_venture | nri_enquiry | general_contact — derived from source by submit_lead().';
comment on column public.leads.client_ip_hash is
  'Salted SHA-256 of the submitter IP, used only for rate limiting. Raw IPs are never stored.';

-- Explicit, reversible backfill of existing rows (source -> lead_type).
-- To undo: update public.leads set lead_type = null;
update public.leads set lead_type = case source
    when 'property_enquiry' then 'buyer_enquiry'
    when 'list_with_us'     then 'seller_lead'
    when 'free_valuation'   then 'seller_lead'
    when 'joint_venture'    then 'joint_venture'
    when 'nri_services'     then 'nri_enquiry'
    else 'general_contact'
  end
where lead_type is null;

alter table public.leads drop constraint if exists leads_lead_type_check;
alter table public.leads add constraint leads_lead_type_check
  check (lead_type is null or lead_type in ('buyer_enquiry','seller_lead','joint_venture','nri_enquiry','general_contact')) not valid;

alter table public.leads drop constraint if exists leads_status_check;
alter table public.leads add constraint leads_status_check
  check (status in ('New','Contacted','Follow-up','Qualified','Closed','Not Interested')) not valid;

alter table public.leads drop constraint if exists leads_source_check;
alter table public.leads add constraint leads_source_check
  check (source in ('property_enquiry','list_with_us','free_valuation','joint_venture','nri_services','contact_form')) not valid;

-- ---------------------------------------------------------------------
-- 2. Indexes
-- ---------------------------------------------------------------------
create index if not exists idx_leads_phone_recent  on public.leads (phone, created_at desc);
create index if not exists idx_leads_ip_recent     on public.leads (client_ip_hash, created_at desc) where client_ip_hash is not null;
create index if not exists idx_leads_property      on public.leads (property_id) where property_id is not null;
create index if not exists idx_leads_lead_type     on public.leads (lead_type);

-- ---------------------------------------------------------------------
-- 3. Private secrets (not exposed through the API)
-- ---------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public;
revoke all on schema private from anon, authenticated;

create table if not exists private.app_secrets (
  key   text primary key,
  value text not null
);
revoke all on private.app_secrets from public, anon, authenticated;

-- Salt for hashing IPs. Generated once, never leaves the database.
insert into private.app_secrets (key, value)
values ('ip_hash_salt', encode(gen_random_bytes(32), 'hex'))
on conflict (key) do nothing;

-- OPTIONAL: to require every lead to come through the site's Worker
-- (which verifies Cloudflare Turnstile and the honeypot), set a gate
-- secret here AND the same value as the Worker secret LEAD_GATE_SECRET:
--   insert into private.app_secrets (key, value) values ('lead_gate_secret', '<long random string>')
--   on conflict (key) do update set value = excluded.value;
-- Without it, submit_lead() still validates and rate-limits everything.

-- ---------------------------------------------------------------------
-- 4. submit_lead()
-- ---------------------------------------------------------------------
drop function if exists public.submit_lead(text,text,text,text,text,text,uuid,jsonb,text,text,text);

create or replace function public.submit_lead(
  p_source         text,
  p_name           text,
  p_phone          text,
  p_email          text  default null,
  p_whatsapp       text  default null,
  p_message        text  default null,
  p_property_id    uuid  default null,
  p_source_details jsonb default null,
  p_honeypot       text  default null,
  p_gate           text  default null,
  p_client_ip      text  default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_name      text := nullif(btrim(coalesce(p_name, '')), '');
  v_phone     text := nullif(btrim(coalesce(p_phone, '')), '');
  v_whatsapp  text := nullif(btrim(coalesce(p_whatsapp, '')), '');
  v_email     text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_message   text := nullif(btrim(coalesce(p_message, '')), '');
  v_digits    text;
  v_lead_type text;
  v_title     text;
  v_gate      text;
  v_gate_ok   boolean := false;
  v_ip        text;
  v_ip_hash   text;
  v_details   jsonb := '{}'::jsonb;
  v_key       text;
  v_val       jsonb;
  v_id        uuid;
begin
  -- Honeypot: bots fill hidden fields. Pretend success, store nothing.
  if nullif(btrim(coalesce(p_honeypot, '')), '') is not null then
    return jsonb_build_object('ok', true);
  end if;

  -- Optional gate secret (only enforced once configured).
  select value into v_gate from private.app_secrets where key = 'lead_gate_secret';
  if v_gate is not null then
    if p_gate is null or p_gate <> v_gate then
      return jsonb_build_object('ok', false, 'error', 'forbidden');
    end if;
    v_gate_ok := true;
  end if;

  v_lead_type := case p_source
    when 'property_enquiry' then 'buyer_enquiry'
    when 'list_with_us'     then 'seller_lead'
    when 'free_valuation'   then 'seller_lead'
    when 'joint_venture'    then 'joint_venture'
    when 'nri_services'     then 'nri_enquiry'
    when 'contact_form'     then 'general_contact'
    else null end;
  if v_lead_type is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_source');
  end if;

  -- Validation ---------------------------------------------------------
  if v_name is null or char_length(v_name) < 2 or char_length(v_name) > 100 then
    return jsonb_build_object('ok', false, 'error', 'invalid_name');
  end if;

  v_digits := regexp_replace(coalesce(v_phone, ''), '[^0-9]', '', 'g');
  if v_phone is null or char_length(v_phone) > 25
     or v_phone !~ '^\+?[0-9 ()\-.]+$'
     or char_length(v_digits) not between 8 and 15 then
    return jsonb_build_object('ok', false, 'error', 'invalid_phone');
  end if;

  if v_whatsapp is not null and (
       char_length(v_whatsapp) > 25 or v_whatsapp !~ '^\+?[0-9 ()\-.]+$'
       or char_length(regexp_replace(v_whatsapp, '[^0-9]', '', 'g')) not between 8 and 15) then
    return jsonb_build_object('ok', false, 'error', 'invalid_whatsapp');
  end if;

  if v_email is not null and (char_length(v_email) > 254
       or v_email !~ '^[^@\s<>]+@[^@\s<>]+\.[a-z]{2,}$') then
    return jsonb_build_object('ok', false, 'error', 'invalid_email');
  end if;

  if v_message is not null and char_length(v_message) > 2000 then
    return jsonb_build_object('ok', false, 'error', 'message_too_long');
  end if;

  -- Extra form fields: flat object of short strings only.
  if p_source_details is not null then
    if jsonb_typeof(p_source_details) <> 'object' then
      return jsonb_build_object('ok', false, 'error', 'invalid_details');
    end if;
    if (select count(*) from jsonb_object_keys(p_source_details)) > 30 then
      return jsonb_build_object('ok', false, 'error', 'invalid_details');
    end if;
    for v_key, v_val in select * from jsonb_each(p_source_details) loop
      if char_length(v_key) > 60 or jsonb_typeof(v_val) not in ('string','number') then
        return jsonb_build_object('ok', false, 'error', 'invalid_details');
      end if;
      if char_length(v_val #>> '{}') > 1000 then
        return jsonb_build_object('ok', false, 'error', 'invalid_details');
      end if;
      v_details := v_details || jsonb_build_object(v_key, left(v_val #>> '{}', 1000));
    end loop;
  end if;

  -- Property: must be a live listing; title comes from the database.
  if p_property_id is not null then
    select title into v_title from public.properties
     where id = p_property_id and is_published = true and is_archived = false;
    if v_title is null then
      return jsonb_build_object('ok', false, 'error', 'invalid_property');
    end if;
  end if;

  -- Client IP, used only for rate limiting:
  --  1. p_client_ip — trusted when the gate secret proves the call came
  --     from the site's Worker;
  --  2. x-dgss-client-ip — set by the Worker on every forwarded lead.
  --     Needed because when the Worker calls Supabase, cf-connecting-ip /
  --     x-forwarded-for are CLOUDFLARE'S shared address, which would lump
  --     every visitor into one bucket. A direct caller could fake this
  --     header, but that only lets them dodge the per-IP limit (which they
  --     could do by switching IPs anyway); the per-phone and site-wide
  --     limits still apply;
  --  3. otherwise the real connecting IP (direct browser calls).
  begin
    v_ip := coalesce(
      case when v_gate_ok then nullif(btrim(coalesce(p_client_ip, '')), '') end,
      nullif(btrim(current_setting('request.headers', true)::json ->> 'x-dgss-client-ip'), ''),
      nullif(btrim(current_setting('request.headers', true)::json ->> 'cf-connecting-ip'), ''),
      nullif(btrim(split_part(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ',', 1)), '')
    );
  exception when others then
    v_ip := null;
  end;
  v_ip := left(v_ip, 64);
  if nullif(btrim(coalesce(v_ip, '')), '') is not null then
    v_ip_hash := encode(digest(btrim(v_ip) || (select value from private.app_secrets where key = 'ip_hash_salt'), 'sha256'), 'hex');
  end if;

  -- De-duplicate accidental double submits.
  if exists (
    select 1 from public.leads
     where regexp_replace(phone, '[^0-9]', '', 'g') = v_digits
       and source = p_source
       and property_id is not distinct from p_property_id
       and created_at > now() - interval '10 minutes'
  ) then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;

  -- Rate limits.
  if (select count(*) from public.leads
       where regexp_replace(phone, '[^0-9]', '', 'g') = v_digits
         and created_at > now() - interval '1 hour') >= 5 then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;
  if v_ip_hash is not null and (select count(*) from public.leads
       where client_ip_hash = v_ip_hash and created_at > now() - interval '1 hour') >= 10 then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;
  -- Site-wide ceiling against floods. Kept high so an attacker can't
  -- easily lock out genuine visitors; enable Turnstile + the gate secret
  -- for stronger protection.
  if (select count(*) from public.leads where created_at > now() - interval '1 hour') >= 500 then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  insert into public.leads (name, phone, whatsapp, email, message,
                            property_id, property_title_snapshot,
                            source, lead_type, source_details, client_ip_hash)
  values (v_name, v_phone, v_whatsapp, v_email, v_message,
          p_property_id, v_title,
          p_source, v_lead_type, v_details, v_ip_hash)
  returning id into v_id;

  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.submit_lead(text,text,text,text,text,text,uuid,jsonb,text,text,text) from public;
grant execute on function public.submit_lead(text,text,text,text,text,text,uuid,jsonb,text,text,text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 5. Remove direct public inserts
-- ---------------------------------------------------------------------
drop policy if exists "public can submit leads" on public.leads;

commit;
