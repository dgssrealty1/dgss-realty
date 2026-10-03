#!/usr/bin/env python3
"""RLS / authorization test matrix for the DGSS Realty migrations.

Runs against a local Postgres that has:
  supabase/tests/00_supabase_stub.sql, supabase/schema.sql,
  supabase/add-founder-settings.sql, seed-existing-properties.sql and
  every file in supabase/migrations/ applied.

Each check runs inside its own transaction that is rolled back, as a
given Postgres role (anon / authenticated) with a given auth.uid().

Usage: python3 supabase/tests/rls_test.py <dbname>
"""
import subprocess, sys, uuid

DB = sys.argv[1] if len(sys.argv) > 1 else "migrated"
PSQL = ["psql", "-h", "/var/tmp/pgtest", "-p", "5433", "-U", "postgres", "-d", DB, "-At", "-q", "-v", "ON_ERROR_STOP=1"]

def sql(q):
    r = subprocess.run(PSQL + ["-c", q], capture_output=True, text=True)
    if r.returncode != 0:
        return r.returncode, (r.stdout.strip() + "\n" + r.stderr.strip()).strip()
    return r.returncode, (r.stdout.strip() or r.stderr.strip())

def setup():
    ids = {}
    for role in ["super_admin", "admin", "editor", "sales", "viewer", "stranger"]:
        uid = str(uuid.uuid4())
        ids[role] = uid
        sql(f"insert into auth.users(id,email) values ('{uid}','{role}-{uid[:6]}@test.local')")
        if role != "stranger":
            sql(f"insert into admin_users(user_id, role) values ('{uid}','{role}')")
    # one draft + one lead + one testimonial to test against
    sql("insert into properties(slug,title,category,listing_type,status,is_published) values ('draft-test','Draft Test','Flat','For Sale','Available',false) on conflict do nothing")
    sql("insert into leads(name,phone,source,lead_type) values ('Seed Lead','9876543210','contact_form','general_contact')")
    sql("insert into testimonials(client_name,review,is_published) values ('Hidden','Unpublished review',false)")
    return ids

def run_as(who, ids, stmt):
    if who == "anon":
        pre = "set local role anon; select set_config('request.jwt.claim.role','anon',true);"
    else:
        pre = (f"set local role authenticated; select set_config('request.jwt.claim.role','authenticated',true);"
               f"select set_config('request.jwt.claim.sub','{ids[who]}',true);")
    return sql(f"begin; {pre} {stmt}; rollback;")

def outcome(code, out):
    if code != 0:
        return "DENIED"
    last = out.splitlines()[-1] if out else ""
    return last

results = []
# On projects with locked-down default privileges (the live project), a
# role with no table grant gets "permission denied" where the permissive
# model returns 0 rows. Both mean "blocked", so LIVE_MODEL=1 treats them
# as equal for expected-"0" checks. Nothing else is relaxed.
import os
BLOCKED_EQUIV = os.environ.get("LIVE_MODEL") == "1"

def check(label, who, stmt, expect, ids):
    code, out = run_as(who, ids, stmt)
    got = outcome(code, out)
    ok = (got == expect) or (BLOCKED_EQUIV and expect == "0" and got == "DENIED")
    results.append((ok, label, who, expect, got if not ok else ""))

def main():
    ids = setup()
    W = lambda s: f"with x as ({s} returning 1) select count(*) from x"
    everyone = ["anon", "stranger", "viewer", "sales", "editor", "admin", "super_admin"]

    # --- properties: read -------------------------------------------------
    for who in everyone:
        n = "6" if who not in ("anon", "stranger") else "5"   # 5 published + 1 draft
        check("read properties (drafts hidden from public)", who, "select count(*) from properties", n, ids)

    # --- properties: update title of a published property ---------------
    upd = W("update properties set title = title || '!' where slug='2bhk-flat-nandanam'")
    exp = {"anon": "0", "stranger": "0", "viewer": "0", "sales": "0", "editor": "1", "admin": "1", "super_admin": "1"}
    for who in everyone:
        check("edit property content", who, upd, exp[who], ids)

    # --- properties: publish/unpublish (editor blocked by trigger) -------
    pub = W("update properties set is_published = true where slug='draft-test'")
    exp = {"anon": "0", "stranger": "0", "viewer": "0", "sales": "0", "editor": "DENIED", "admin": "1", "super_admin": "1"}
    for who in everyone:
        check("publish property", who, pub, exp[who], ids)

    arch = W("update properties set is_archived = true where slug='2bhk-flat-nandanam'")
    exp = {"anon": "0", "stranger": "0", "viewer": "0", "sales": "0", "editor": "DENIED", "admin": "1", "super_admin": "1"}
    for who in everyone:
        check("archive property", who, arch, exp[who], ids)

    # --- properties: insert ----------------------------------------------
    ins = W("insert into properties(slug,title,category,listing_type) values ('','New One','Villa','For Sale')")
    exp = {"anon": "DENIED", "stranger": "DENIED", "viewer": "DENIED", "sales": "DENIED", "editor": "1", "admin": "1", "super_admin": "1"}
    for who in everyone:
        check("create draft property", who, ins, exp[who], ids)
    check("editor cannot create already-published", "editor",
          W("insert into properties(slug,title,category,listing_type,is_published) values ('','Sneaky','Villa','For Sale',true)"), "DENIED", ids)

    # --- properties: delete ----------------------------------------------
    dele = W("delete from properties where slug='draft-test'")
    exp = {"anon": "0", "stranger": "0", "viewer": "0", "sales": "0", "editor": "0", "admin": "1", "super_admin": "1"}
    for who in everyone:
        check("delete property", who, dele, exp[who], ids)

    # --- property_images -------------------------------------------------
    pub_id = sql("select id from properties where slug='2bhk-flat-nandanam'")[1]
    draft_id = sql("select id from properties where slug='draft-test'")[1]
    imgins = W(f"insert into property_images(property_id,storage_path,public_url) values ('{pub_id}','{pub_id}/x.jpg','http://x')")
    exp = {"anon": "DENIED", "stranger": "DENIED", "viewer": "DENIED", "sales": "DENIED", "editor": "1", "admin": "1", "super_admin": "1"}
    for who in everyone:
        check("add property image", who, imgins, exp[who], ids)

    # --- leads -------------------------------------------------------------
    exp = {"anon": "0", "stranger": "0", "viewer": "0", "sales": "1", "editor": "0", "admin": "1", "super_admin": "1"}
    for who in everyone:
        check("read leads (personal data)", who, "select count(*) from leads", exp[who], ids)
    for who in everyone:
        check("direct insert into leads is blocked", who,
              W("insert into leads(name,phone,source) values ('x','9999999999','contact_form')"), "DENIED", ids)
    exp = {"anon": "0", "stranger": "0", "viewer": "0", "sales": "1", "editor": "0", "admin": "1", "super_admin": "1"}
    for who in everyone:
        check("update lead status", who, W("update leads set status='Contacted' where name='Seed Lead'"), exp[who], ids)
    exp = {"anon": "0", "stranger": "0", "viewer": "0", "sales": "0", "editor": "0", "admin": "0", "super_admin": "1"}
    for who in everyone:
        check("hard-delete lead", who, W("delete from leads where name='Seed Lead'"), exp[who], ids)

    # --- testimonials ------------------------------------------------------
    exp = {"anon": "0", "stranger": "0", "viewer": "1", "sales": "1", "editor": "1", "admin": "1", "super_admin": "1"}
    for who in everyone:
        check("see unpublished testimonial", who, "select count(*) from testimonials where client_name='Hidden'", exp[who], ids)
    exp = {"anon": "0", "stranger": "0", "viewer": "0", "sales": "0", "editor": "1", "admin": "1", "super_admin": "1"}
    for who in everyone:
        check("edit testimonial", who, W("update testimonials set review='x' where client_name='Hidden'"), exp[who], ids)

    # --- settings ----------------------------------------------------------
    for who in everyone:
        check("read settings (public)", who, "select count(*) from settings", "1", ids)
    exp = {"anon": "0", "stranger": "0", "viewer": "0", "sales": "0", "editor": "0", "admin": "1", "super_admin": "1"}
    for who in everyone:
        check("update settings", who, W("update settings set phone='+91 98400 00001' where id=1"), exp[who], ids)

    # --- admin_users: privilege escalation --------------------------------
    for who in ["stranger", "viewer", "editor", "admin"]:
        check("cannot self-promote to super_admin", who,
              W(f"insert into admin_users(user_id,role) values ('{ids[who]}','super_admin') on conflict (user_id) do update set role='super_admin'"),
              "DENIED", ids)
    check("super_admin can add staff", "super_admin",
          W(f"insert into admin_users(user_id,role) values ('{ids['stranger']}','viewer')"), "1", ids)
    check("stranger sees no admin_users rows", "stranger", "select count(*) from admin_users", "0", ids)
    check("viewer sees only own admin_users row", "viewer", "select count(*) from admin_users", "1", ids)

    # --- storage -----------------------------------------------------------
    sql(f"insert into storage.objects(bucket_id,name) values ('property-images','{draft_id}/existing.jpg')")
    good_path = "(select id::text from properties where slug='draft-test') || '/photo.jpg'"
    exp = {"anon": "DENIED", "stranger": "DENIED", "viewer": "DENIED", "sales": "DENIED", "editor": "1", "admin": "1", "super_admin": "1"}
    for who in everyone:
        check("upload image into property folder", who,
              W(f"insert into storage.objects(bucket_id,name) values ('property-images', {good_path})"), exp[who], ids)
    check("editor cannot upload outside a property folder", "editor",
          W("insert into storage.objects(bucket_id,name) values ('property-images','random/evil.jpg')"), "DENIED", ids)
    exp = {"anon": "0", "stranger": "0", "viewer": "1", "sales": "1", "editor": "1", "admin": "1", "super_admin": "1"}
    for who in everyone:
        check("list bucket (public cannot enumerate)", who, "select count(*) from storage.objects where bucket_id='property-images'", exp[who], ids)
    exp = {"anon": "0", "stranger": "0", "viewer": "0", "sales": "0", "editor": "1", "admin": "1", "super_admin": "1"}
    for who in everyone:
        check("delete storage object", who, W(f"delete from storage.objects where name='{draft_id}/existing.jpg'"), exp[who], ids)

    # --- storage reads after migration 04 (private bucket) -----------------
    check("bucket is private", "anon", "select public::text from storage.buckets where id='property-images'", "false", ids)
    sql(f"insert into storage.objects(bucket_id,name) values ('property-images','{pub_id}/live.jpg'),('property-images','{draft_id}/draft.jpg')")
    exp = {"anon": "1", "stranger": "1", "viewer": "1", "sales": "1", "editor": "1", "admin": "1", "super_admin": "1"}
    for who in everyone:
        check("read image of PUBLISHED property", who, f"select count(*) from storage.objects where name='{pub_id}/live.jpg'", exp[who], ids)
    exp = {"anon": "0", "stranger": "0", "viewer": "1", "sales": "1", "editor": "1", "admin": "1", "super_admin": "1"}
    for who in everyone:
        check("read image of DRAFT property (staff only)", who, f"select count(*) from storage.objects where name='{draft_id}/draft.jpg'", exp[who], ids)
    code, out = sql(f"""begin; update properties set is_archived = true where id = '{pub_id}';
      set local role anon; select count(*) from storage.objects where name='{pub_id}/live.jpg'; rollback;""")
    results.append((out.splitlines()[-1] == "0", "image of ARCHIVED property hidden from public", "anon", "0", out.splitlines()[-1]))

    # --- submit_lead() -----------------------------------------------------
    def lead(args):
        return f"select public.submit_lead({args})->>'{'error' if 'err' in args else 'ok'}'"
    q = lambda a, key="ok": f"select public.submit_lead({a})->>'{key}'"
    check("anon can submit valid lead", "anon", q("'contact_form','Ravi','+91 98410 00001','r@x.com',null,'hello'"), "true", ids)
    check("bad phone rejected", "anon", q("'contact_form','Ravi','12ab'", "error"), "invalid_phone", ids)
    check("bad email rejected", "anon", q("'contact_form','Ravi','9841000001','not-an-email'", "error"), "invalid_email", ids)
    check("unknown source rejected", "anon", q("'hacker','Ravi','9841000001'", "error"), "invalid_source", ids)
    check("too-long message rejected", "anon", q("'contact_form','Ravi','9841000001',null,null,repeat('a',2001)", "error"), "message_too_long", ids)
    check("html in name is stored as text only (<=100 chars ok)", "anon",
          q("'contact_form','<img src=x onerror=alert(1)>','9841000009'"), "true", ids)
    check("draft property id rejected", "anon",
          q(f"'property_enquiry','Ravi','9841000001',null,null,null,'{draft_id}'", "error"), "invalid_property", ids)
    check("honeypot silently ignored", "anon",
          f"select public.submit_lead('contact_form','Bot','9841000002',p_honeypot=>'http://spam') ->> 'ok'", "true", ids)
    check("honeypot row not stored", "super_admin", "select count(*) from leads where name='Bot'", "0", ids)

    # property snapshot comes from DB, not client
    code, out = sql("""begin; set local role anon;
      select public.submit_lead('property_enquiry','Priya','9841000003',p_property_id=>(select id from properties where slug='2bhk-flat-nandanam'));
      reset role;
      select property_title_snapshot || '|' || lead_type from leads where name='Priya';
      rollback;""")
    results.append((out.splitlines()[-1] == "2 BHK Flat – Nandanam|buyer_enquiry", "enquiry stores property_id + DB title + lead_type", "anon", "2 BHK Flat – Nandanam|buyer_enquiry", out.splitlines()[-1]))

    # duplicate + rate limit (in one transaction)
    code, out = sql("""begin; set local role anon;
      select public.submit_lead('contact_form','Dup','9841000004')->>'ok';
      select public.submit_lead('contact_form','Dup','9841000004')->>'duplicate';
      select public.submit_lead('free_valuation','Dup','9841000004',p_source_details=>'{"Location":"Adyar"}')->>'ok';
      select public.submit_lead('joint_venture','Dup','9841000004')->>'ok';
      select public.submit_lead('nri_services','Dup','9841000004',p_email=>'a@b.co')->>'ok';
      select public.submit_lead('list_with_us','Dup','9841000004')->>'ok';
      select public.submit_lead('property_enquiry','Dup','9841000004')->>'error';
      rollback;""")
    lines = out.splitlines()
    results.append((lines[-7:] == ["true", "true", "true", "true", "true", "true", "rate_limited"],
                    "duplicate detection + 5/hour phone rate limit", "anon",
                    "true,true(dup),true,true,true,true,rate_limited", ",".join(lines[-7:])))

    # IP rate limit via request.headers
    stmts = ";".join(f"select public.submit_lead('contact_form','Ip','98410100{i:02d}')->>'ok'" for i in range(11))
    code, out = sql(f"""begin; set local role anon;
      select set_config('request.headers','{{"cf-connecting-ip":"203.0.113.9"}}',true);
      {stmts};
      rollback;""")
    lines = out.splitlines()
    tail = lines[-11:]
    results.append((tail == ["true"] * 10 + ["false"],
                    "per-IP rate limit (10/hour, 11th refused)", "anon", "10x true then false", ",".join(tail)))

    # Behind the Worker: many visitors share Cloudflare's outbound IP but
    # carry their own x-dgss-client-ip -> must NOT be lumped together.
    stmts = ";".join(
        f"select set_config('request.headers','{{\"cf-connecting-ip\":\"198.51.100.1\",\"x-dgss-client-ip\":\"203.0.113.{i}\"}}',true); "
        f"select public.submit_lead('contact_form','Visitor','98420200{i:02d}')->>'ok'" for i in range(12))
    code, out = sql(f"begin; set local role anon; {stmts}; rollback;")
    oks = [l for l in out.splitlines() if l in ("true", "false")]
    results.append((oks == ["true"] * 12, "12 different visitors via the Worker all accepted", "anon", "12x true", ",".join(oks)))

    # gate secret
    code, out = sql("""begin;
      insert into private.app_secrets values ('lead_gate_secret','s3cret');
      set local role anon;
      select public.submit_lead('contact_form','Gate','9841000005')->>'error';
      select public.submit_lead('contact_form','Gate','9841000005',p_gate=>'s3cret')->>'ok';
      rollback;""")
    lines = out.splitlines()
    results.append((lines[-2:] == ["forbidden", "true"], "gate secret enforced when configured", "anon", "forbidden,true", ",".join(lines[-2:])))

    # anon cannot read private secrets
    check("anon cannot read private.app_secrets", "anon", "select count(*) from private.app_secrets", "DENIED", ids)

    # --- slugs ---------------------------------------------------------------
    code, out = sql("""begin;
      insert into properties(slug,title,category,listing_type,location) values ('','3 BHK Villa','Villa','For Sale','ECR') returning slug;
      insert into properties(slug,title,category,listing_type,location) values ('','3 BHK Villa','Villa','For Sale','ECR') returning slug;
      insert into properties(slug,title,category,listing_type) values ('  Hello  World!! ','x','Villa','For Sale') returning slug;
      update properties set slug='nandanam-2bhk-renamed' where slug='2bhk-flat-nandanam';
      select old_slug from property_slug_redirects;
      update properties set title='changed title' where slug='prime-residential-property-perambur' returning slug;
      rollback;""")
    lines = [l for l in out.splitlines() if l and not l.startswith(("INSERT", "UPDATE", "BEGIN", "ROLLBACK"))]
    exp_lines = ["3-bhk-villa-ecr", "3-bhk-villa-ecr-2", "hello-world", "2bhk-flat-nandanam", "prime-residential-property-perambur"]
    results.append((lines == exp_lines, "slug generate / dedupe / normalize / redirect / stable on edit", "postgres", exp_lines, lines))

    # =======================================================================
    # MIGRATION 05 — CMS integrity, staff, workflow, CRM, audit, storage
    # =======================================================================
    def raw(label, stmts, expect_lines, who="postgres"):
        """Runs a multi-statement script; compares the last N output lines."""
        code, out = sql(f"begin; {stmts}; rollback;")
        lines = [l for l in out.splitlines() if l and l not in ("BEGIN", "ROLLBACK")]
        got = lines[-len(expect_lines):] if code == 0 else ["DENIED"]
        ok = got == expect_lines or (BLOCKED_EQUIV and expect_lines == ["0"] and code != 0 and "permission denied" in out)
        results.append((ok, label, who, expect_lines, got if code == 0 else out[-200:]))

    def as_user(who):
        return (f"set local role authenticated; select set_config('request.jwt.claim.role','authenticated',true);"
                f"select set_config('request.jwt.claim.sub','{ids[who]}',true)")
    q1 = lambda s: f"select ({s})::text"

    # --- staff management ---------------------------------------------------
    inactive = str(uuid.uuid4())
    sql(f"insert into auth.users(id,email) values ('{inactive}','inactive-{inactive[:6]}@test.local')")
    sql(f"insert into admin_users(user_id, role, is_active) values ('{inactive}','admin',false)")
    ids["inactive_admin"] = inactive
    check("deactivated admin sees only public properties", "inactive_admin", "select count(*) from properties", "5", ids)
    check("deactivated admin cannot read leads", "inactive_admin", "select count(*) from leads", "0", ids)
    check("deactivated admin has no role", "inactive_admin", "select coalesce(public.current_admin_role(),'none')", "none", ids)
    check("super_admin can list staff (with emails)", "super_admin", "select (count(*) >= 6)::text from public.list_staff()", "true", ids)
    for who in ["anon", "stranger", "viewer", "sales", "editor", "admin"]:
        check("only super_admin can list staff", who, "select count(*) from public.list_staff()", "DENIED", ids)
    code, email = sql(f"select email from auth.users where id='{ids['stranger']}'")
    check("super_admin adds existing account as staff", "super_admin",
          f"select public.add_staff_by_email('{email}','editor','New Editor')->>'ok'", "true", ids)
    check("add staff: unknown email reported", "super_admin",
          "select public.add_staff_by_email('nobody@nowhere.test','editor')->>'error'", "no_account", ids)
    check("add staff: invalid role rejected", "super_admin",
          f"select public.add_staff_by_email('{email}','owner')->>'error'", "invalid_role", ids)
    for who in ["admin", "editor", "sales", "viewer", "stranger"]:
        check("cannot grant roles via add_staff_by_email", who,
              f"select public.add_staff_by_email('{email}','super_admin')->>'ok'", "DENIED", ids)
    check("admin cannot change another staff role", "admin",
          W(f"update admin_users set role='super_admin' where user_id='{ids['editor']}'"), "0", ids)
    check("editor cannot reactivate/promote self", "editor",
          W(f"update admin_users set role='admin', is_active=true where user_id='{ids['editor']}'"), "0", ids)
    check("super_admin can change a role", "super_admin",
          W(f"update admin_users set role='sales' where user_id='{ids['viewer']}'"), "1", ids)
    raw("last ACTIVE super_admin cannot be deactivated",
        f"update admin_users set is_active=false where role='super_admin' and user_id <> '{ids['super_admin']}'; "
        f"{as_user('super_admin')}; update admin_users set is_active=false where user_id='{ids['super_admin']}'",
        ["DENIED"])
    raw("last ACTIVE super_admin cannot be demoted",
        f"update admin_users set is_active=false where role='super_admin' and user_id <> '{ids['super_admin']}'; "
        f"{as_user('super_admin')}; update admin_users set role='admin' where user_id='{ids['super_admin']}'",
        ["DENIED"])
    raw("a second super_admin CAN be deactivated",
        f"{as_user('super_admin')}; with x as (update admin_users set is_active=false where role='super_admin' "
        f"and user_id <> '{ids['super_admin']}' returning 1) select count(*) from x", ["1"])

    # --- featured image -----------------------------------------------------
    img = lambda n, feat, order: (f"insert into property_images(property_id,storage_path,public_url,is_featured_image,sort_order) "
                                  f"values ('{draft_id}','{draft_id}/{n}.jpg','x',{feat},{order})")
    raw("database allows only ONE featured image per property",
        f"{img('a', 'true', 0)}; {img('b', 'true', 1)}", ["DENIED"])
    raw("set_featured_image switches atomically (editor)",
        f"{img('a', 'true', 0)}; {img('b', 'false', 1)}; {as_user('editor')}; "
        f"select public.set_featured_image((select id from property_images where storage_path='{draft_id}/b.jpg')); "
        f"select string_agg(storage_path || '=' || is_featured_image, ',' order by storage_path) from property_images where property_id='{draft_id}'",
        [f"{draft_id}/a.jpg=false,{draft_id}/b.jpg=true"])
    raw("viewer cannot change the featured image",
        f"{img('a', 'true', 0)}; {img('b', 'false', 1)}; {as_user('viewer')}; "
        f"select public.set_featured_image((select id from property_images where storage_path='{draft_id}/b.jpg'))",
        ["DENIED"])
    raw("deleting the featured image promotes the next one",
        f"{img('a', 'true', 0)}; {img('b', 'false', 1)}; {img('c', 'false', 2)}; {as_user('editor')}; "
        f"delete from property_images where storage_path='{draft_id}/a.jpg'; "
        f"select string_agg(storage_path, ',') from property_images where property_id='{draft_id}' and is_featured_image",
        [f"{draft_id}/b.jpg"])
    raw("deleting the only image leaves no featured image (valid state)",
        f"{img('a', 'true', 0)}; {as_user('editor')}; delete from property_images where storage_path='{draft_id}/a.jpg'; "
        f"select count(*) from property_images where property_id='{draft_id}'", ["0"])

    # --- image record path integrity -----------------------------------------
    check("image record with unsafe path rejected", "editor",
          W(f"insert into property_images(property_id,storage_path,public_url) values ('{draft_id}','{draft_id}/../../x.jpg','x')"), "DENIED", ids)
    check("image record pointing at ANOTHER property's folder rejected", "editor",
          W(f"insert into property_images(property_id,storage_path,public_url) values ('{draft_id}','{pub_id}/x.jpg','x')"), "DENIED", ids)
    check("image record: public URL derived from the path", "editor",
          f"insert into property_images(property_id,storage_path,public_url) values ('{draft_id}','{draft_id}/ok.webp','https://evil.example/x.jpg') returning public_url",
          f"/media/property-images/{draft_id}/ok.webp", ids)

    # --- business rules -------------------------------------------------------
    for lt, st, exp in [("For Sale", "Rented", "DENIED"), ("For Sale", "Leased", "DENIED"), ("For Rent", "Sold", "DENIED"),
                        ("For Lease", "Sold", "DENIED"), ("For Rent", "Leased", "1"), ("For Lease", "Rented", "1"),
                        ("For Sale", "Sold", "1"), ("For Sale", "Under Offer", "1"), ("For Rent", "Rented", "1")]:
        check(f"business rule: {lt} + {st}", "admin",
              W(f"update properties set listing_type='{lt}', status='{st}' where slug='draft-test'"), exp, ids)
    raw("legacy inconsistent row can still be edited (rules apply only when type/status change)",
        "alter table properties disable trigger trg_property_business_rules; "
        "update properties set listing_type='For Sale', status='Rented' where slug='draft-test'; "
        "alter table properties enable trigger trg_property_business_rules; "
        f"{as_user('editor')}; with x as (update properties set title='Legacy edit' where slug='draft-test' returning 1) select count(*) from x",
        ["1"])

    # --- review workflow ------------------------------------------------------
    check("editor submits draft for review", "editor",
          W("update properties set review_status='under_review' where slug='draft-test'"), "1", ids)
    check("editor cannot approve", "editor",
          W("update properties set review_status='approved' where slug='draft-test'"), "DENIED", ids)
    check("editor cannot create an approved listing", "editor",
          W("insert into properties(slug,title,category,listing_type,review_status) values ('','X','Villa','For Sale','approved')"), "DENIED", ids)
    check("admin approves", "admin",
          W("update properties set review_status='approved' where slug='draft-test'"), "1", ids)
    raw("editor changing an APPROVED draft sends it back to review",
        f"update properties set review_status='approved' where slug='draft-test'; {as_user('editor')}; "
        "update properties set title='Changed after approval' where slug='draft-test'; "
        "select review_status from properties where slug='draft-test'", ["under_review"])
    raw("publishing marks the listing approved",
        f"{as_user('admin')}; update properties set is_published=true where slug='draft-test'; "
        "select review_status from properties where slug='draft-test'", ["approved"])
    check("sales cannot submit for review", "sales",
          W("update properties set review_status='under_review' where slug='draft-test'"), "0", ids)

    # --- internal property data -------------------------------------------------
    sql(f"insert into property_internal(property_id, owner_name, owner_phone, mandate) values ('{pub_id}','Owner Name','9840000000','exclusive') on conflict do nothing")
    exp = {"anon": "DENIED", "stranger": "0", "viewer": "0", "sales": "1", "editor": "1", "admin": "1", "super_admin": "1"}
    for who in everyone:
        check("internal owner data visible to permitted staff only", who, "select count(*) from property_internal", exp[who], ids)
    exp = {"anon": "DENIED", "stranger": "DENIED", "viewer": "DENIED", "sales": "DENIED", "editor": "1", "admin": "1", "super_admin": "1"}
    for who in everyone:
        check("write internal data", who,
              W(f"insert into property_internal(property_id, owner_name) values ('{draft_id}','X')"), exp[who], ids)
    check("internal data is not a column of the public properties table", "anon",
          "select count(*) from information_schema.columns where table_name='properties' and column_name in ('owner_name','owner_phone','internal_notes')", "0", ids)
    check("expiry before listing date rejected", "editor",
          W(f"insert into property_internal(property_id, listing_date, expiry_date) values ('{draft_id}','2026-05-01','2026-01-01')"), "DENIED", ids)

    # --- leads CRM ----------------------------------------------------------------
    lead = "(select id from leads where name='Seed Lead')"
    check("sales can claim an unassigned lead", "sales",
          W(f"update leads set assigned_to='{ids['sales']}' where name='Seed Lead'"), "1", ids)
    check("sales cannot assign a lead to someone else", "sales",
          W(f"update leads set assigned_to='{ids['admin']}' where name='Seed Lead'"), "DENIED", ids)
    check("leads cannot be assigned to an editor", "admin",
          W(f"update leads set assigned_to='{ids['editor']}' where name='Seed Lead'"), "DENIED", ids)
    check("admin assigns lead to sales", "admin",
          W(f"update leads set assigned_to='{ids['sales']}', priority='high', follow_up_date=current_date + 2 where name='Seed Lead'"), "1", ids)
    raw("sales cannot take a lead assigned to another person",
        f"update leads set assigned_to='{ids['admin']}' where name='Seed Lead'; {as_user('sales')}; "
        f"update leads set assigned_to='{ids['sales']}' where name='Seed Lead'", ["DENIED"])
    check("invalid priority rejected", "admin", W("update leads set priority='asap' where name='Seed Lead'"), "DENIED", ids)
    raw("status / assignment / follow-up changes write the timeline",
        f"{as_user('admin')}; update leads set status='Contacted', assigned_to='{ids['sales']}', follow_up_date=current_date+1 where name='Seed Lead'; "
        f"select string_agg(kind, ',' order by kind) from lead_activity where lead_id={lead}",
        ["assigned,follow_up_scheduled,status_changed"])
    raw("follow-up completed is recorded (and next one scheduled)",
        f"update leads set follow_up_date=current_date where name='Seed Lead'; {as_user('sales')}; "
        f"select public.complete_lead_follow_up({lead}, current_date + 7, 'Called, will visit Sunday'); "
        f"select string_agg(kind, ',' order by id) from lead_activity where lead_id={lead}",
        ["follow_up_scheduled,follow_up_completed,follow_up_scheduled,note"])
    check("sales adds own note", "sales",
          W(f"insert into lead_activity(lead_id, actor, kind, detail) values ({lead}, '{ids['sales']}', 'note', '{{\"text\":\"hi\"}}')"), "1", ids)
    check("cannot add a note as someone else", "sales",
          W(f"insert into lead_activity(lead_id, actor, kind, detail) values ({lead}, '{ids['admin']}', 'note', '{{}}')"), "DENIED", ids)
    check("cannot forge system timeline events", "admin",
          W(f"insert into lead_activity(lead_id, actor, kind) values ({lead}, '{ids['admin']}', 'status_changed')"), "DENIED", ids)
    for who in ["anon", "stranger", "viewer", "editor"]:
        check("timeline hidden from non-lead roles", who, "select count(*) from lead_activity",
              "DENIED" if who == "anon" else "0", ids)
    raw("timeline is append-only (no edit/delete, even super_admin)",
        f"{as_user('admin')}; update leads set status='Qualified' where name='Seed Lead'; {as_user('super_admin')}; "
        "with u as (update lead_activity set kind='note' returning 1), d as (delete from lead_activity returning 1) "
        "select (select count(*) from u) + (select count(*) from d)", ["0"])
    check("staff labels for the audit log (admin)", "admin", "select (count(*) >= 5)::text from public.staff_labels()", "true", ids)
    for who in ["sales", "editor", "viewer", "stranger"]:
        check("staff labels hidden from non-admins", who, "select count(*) from public.staff_labels()", "DENIED", ids)
    check("lead assignee list (sales)", "sales", "select (count(*) >= 3)::text from public.lead_assignees()", "true", ids)
    check("lead assignee list hidden from editor", "editor", "select count(*) from public.lead_assignees()", "DENIED", ids)
    check("lead export logged (sales)", "sales", "select 'ok' from public.log_lead_export(3, '{}'::jsonb)", "ok", ids)
    check("editor cannot export leads", "editor", "select 'ok' from public.log_lead_export(3)", "DENIED", ids)

    # --- audit log ------------------------------------------------------------------
    raw("publish / price change / edit are audited separately",
        f"{as_user('admin')}; update properties set is_published=true, display_price='₹1 Cr', title='Audited' where slug='draft-test'; "
        "select string_agg(action, ',' order by action) from audit_log where actor is not null and entity_id=(select id::text from properties where slug='draft-test')",
        ["price_changed,property_edited,property_published"])
    raw("audit entry records who did it and before/after values",
        f"{as_user('admin')}; update properties set display_price='₹2 Cr' where slug='2bhk-flat-nandanam'; "
        f"select (actor = '{ids['admin']}')::text || '|' || actor_role || '|' || (before->>'display_price') || '|' || (after->>'display_price') "
        "from audit_log where action='price_changed' order by id desc limit 1",
        ["true|admin|₹1.90 Crore|₹2 Cr"])
    raw("lead audit entries contain no personal data",
        f"{as_user('admin')}; update leads set status='Closed' where name='Seed Lead'; "
        "select (coalesce(before::text,'') || coalesce(after::text,'') || coalesce(summary,'')) ~ '9876543210|Seed Lead' "
        "from audit_log where action='lead_status_changed' order by id desc limit 1", ["f"])
    raw("internal data audit lists fields, never values",
        f"{as_user('editor')}; update property_internal set owner_phone='9000000001' where property_id='{pub_id}'; reset role; "
        "select summary || '|' || coalesce(after::text,'none') from audit_log where action='internal_data_changed' order by id desc limit 1",
        ["owner_phone|none"])
    raw("settings / staff / testimonial / featured changes are audited",
        f"{as_user('admin')}; update settings set hero_heading='New hero' where id=1; "
        "update testimonials set is_published=true where client_name='Hidden'; "
        f"{as_user('super_admin')}; update admin_users set role='sales' where user_id='{ids['viewer']}'; "
        "select string_agg(distinct action, ',' order by action) from audit_log where action in "
        "('settings_changed','testimonial_published','staff_role_changed')",
        ["settings_changed,staff_role_changed,testimonial_published"])
    exp = {"anon": "DENIED", "stranger": "0", "viewer": "0", "sales": "0", "editor": "0"}
    for who in exp:
        check("audit log hidden from non-admins", who, "select count(*) from audit_log where false = false and id > -1", exp[who], ids)
    check("admin reads audit log", "admin", "select (count(*) >= 0)::text from audit_log", "true", ids)
    for who in ["admin", "super_admin"]:
        check("audit log cannot be inserted by staff", who,
              W("insert into audit_log(action, entity_type) values ('fake','x')"), "DENIED", ids)
        check("audit log cannot be edited by staff", who, W("update audit_log set action='x'"), "DENIED", ids)
        check("audit log cannot be deleted by staff", who, W("delete from audit_log"), "DENIED", ids)

    # --- storage hardening ------------------------------------------------------------
    up = lambda name: W(f"insert into storage.objects(bucket_id,name) values ('property-images', {name})")
    did = "(select id::text from properties where slug='draft-test')"
    for label, name in [("php file", f"{did} || '/evil.php'"), ("space in name", f"{did} || '/a b.jpg'"),
                        ("nested folder", f"{did} || '/x/y.jpg'"), ("dot-dot", f"{did} || '/..jpg'"),
                        ("non-existent property folder", "'00000000-0000-0000-0000-000000000000/a.jpg'")]:
        check(f"upload rejected: {label}", "editor", up(name), "DENIED", ids)
    check("upload accepted: safe name in real property folder", "editor", up(f"{did} || '/1700000000-ab12cd.webp'"), "1", ids)
    raw("editor cannot move a file out of its property folder",
        f"insert into storage.objects(bucket_id,name) values ('property-images','{draft_id}/move.jpg'); {as_user('editor')}; "
        f"update storage.objects set name='random/move.jpg' where name='{draft_id}/move.jpg'", ["DENIED"])
    sql("insert into storage.objects(bucket_id,name) values ('property-images','legacy-folder/old.jpg')")
    exp = {"anon": "0", "stranger": "0", "viewer": "0", "sales": "0", "editor": "0", "admin": "1", "super_admin": "1"}
    for who in everyone:
        check("only admins can delete files outside property folders (orphan clean-up)", who,
              W("delete from storage.objects where name='legacy-folder/old.jpg'"), exp[who], ids)
    exp = {"anon": "DENIED", "stranger": "DENIED", "viewer": "DENIED", "sales": "DENIED", "editor": "DENIED", "admin": "1", "super_admin": "1"}
    for who in everyone:
        check("upload to site-media (branding)", who,
              W("insert into storage.objects(bucket_id,name) values ('site-media','branding/logo-1.png')"), exp[who], ids)
    check("site-media rejects unknown category", "admin",
          W("insert into storage.objects(bucket_id,name) values ('site-media','secret/x.png')"), "DENIED", ids)
    check("site-media rejects svg", "admin",
          W("insert into storage.objects(bucket_id,name) values ('site-media','branding/x.svg')"), "DENIED", ids)
    check("media asset URL derived from path", "admin",
          "insert into media_assets(category, storage_path, public_url) values ('branding','branding/logo-1.png','javascript:x') returning public_url",
          "/media/site-media/branding/logo-1.png", ids)
    check("editor cannot add media assets", "editor",
          W("insert into media_assets(category, storage_path, public_url) values ('general','general/a.png','x')"), "DENIED", ids)
    raw("deleted image record queues its file for clean-up",
        f"insert into property_images(property_id,storage_path,public_url) values ('{draft_id}','{draft_id}/q.jpg','x'); "
        f"insert into storage.objects(bucket_id,name) values ('property-images','{draft_id}/q.jpg'); {as_user('editor')}; "
        f"delete from property_images where storage_path='{draft_id}/q.jpg'; "
        f"select public.resolve_storage_cleanup(array['{draft_id}/q.jpg']); "
        f"delete from storage.objects where name='{draft_id}/q.jpg'; "
        f"select public.resolve_storage_cleanup(array['{draft_id}/q.jpg']); "
        "select count(*) from storage_cleanup_queue",
        ["0", "1", "0"])
    check("storage report (admin)", "admin", "select (public.storage_orphan_report() ? 'unreferenced_files')::text", "true", ids)
    check("storage report hidden from editor", "editor", "select public.storage_orphan_report()::text", "DENIED", ids)

    # --- cache version ------------------------------------------------------------------
    raw("public content change bumps the cache version",
        f"{as_user('editor')}; update properties set title=title where slug='2bhk-flat-nandanam'; "
        "reset role; select version from site_cache_state",
        [str(int(sql('select version from site_cache_state')[1]) + 1)])
    raw("lead submissions do NOT bump the cache version",
        "select version from site_cache_state; set local role anon; select public.submit_lead('contact_form','Cache','9841777777')->>'ok'; "
        "reset role; select version from site_cache_state",
        [sql('select version from site_cache_state')[1], "true", sql('select version from site_cache_state')[1]])
    check("anon reads cache version", "anon", "select count(*) from site_cache_state", "1", ids)
    check("anon cannot change cache version", "anon", W("update site_cache_state set version=0"), "0", ids)

    # --- settings validation ------------------------------------------------------------
    for field, value in [("instagram_url", "javascript:alert(1)"), ("logo_url", "http://insecure.example/logo.png"),
                         ("phone", "call me"), ("whatsapp", "123"), ("email", "not-an-email"),
                         ("hero_cta_text", "x" * 41), ("google_maps_url", "https://maps.example/a b")]:
        check(f"settings rejects bad {field}", "admin", W(f"update settings set {field}='{value}' where id=1"), "DENIED", ids)
    check("settings accepts valid values", "admin",
          W("update settings set instagram_url='https://instagram.com/dgss', logo_url='/media/site-media/branding/logo.png', "
            "whatsapp='+91 98410 09059', email='hello@dgssrealty.com', home_seo_title='Home', office_hours='Mon–Sat 9:30–7' where id=1"), "1", ids)
    check("testimonial photo must be https", "editor",
          W("update testimonials set photo_url='javascript:alert(1)' where client_name='Hidden'"), "DENIED", ids)

    # --- dashboard --------------------------------------------------------------------------
    check("dashboard stats include lead KPIs for sales", "sales", "select (public.dashboard_stats()->'leads' is not null)::text", "true", ids)
    check("dashboard stats hide lead KPIs from editor", "editor", "select (public.dashboard_stats()->'leads' = 'null'::jsonb)::text", "true", ids)
    check("dashboard counts drafts for staff", "viewer", "select (public.dashboard_stats()->'properties'->>'draft')", "1", ids)
    for who in ["anon", "stranger"]:
        check("dashboard stats are staff-only", who, "select public.dashboard_stats()::text", "DENIED", ids)

    # --- report ----------------------------------------------------------------
    failed = [r for r in results if not r[0]]
    for ok, label, who, expect, got in results:
        print(f"{'PASS' if ok else 'FAIL'}  {who:<12} {label}" + ("" if ok else f"   expected={expect} got={got}"))
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)

main()
