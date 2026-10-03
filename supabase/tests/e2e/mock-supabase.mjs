// TEST-ONLY local stand-in for the Supabase HTTP API, used to run the site,
// admin panel and Worker end-to-end against a real local Postgres with the
// real schema, migrations and RLS policies.
//   /rest/v1/*     -> PostgREST (the same engine Supabase uses)
//   /auth/v1/*     -> tiny password login that issues real signed JWTs
//   /storage/v1/*  -> uploads recorded in storage.objects AS THE SIGNED-IN
//                     USER, so the Storage RLS policies are exercised
// Never deploy this. Usage: node mock-supabase.mjs  (see e2e/README in report)
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const PORT = Number(process.env.PORT || 54321);
const PGRST = process.env.PGRST || "http://127.0.0.1:3001";
const SECRET = process.env.JWT_SECRET || "local-test-secret-local-test-secret-000";
const DB = process.env.DB || "e2e";
const PASSWORD = "test-password-123";
const STORE = process.env.STORE || "/var/tmp/pgtest/storage";
fs.mkdirSync(STORE, { recursive: true });

const b64u = b => Buffer.from(b).toString("base64url");
export function sign(payload) {
  const h = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64u(JSON.stringify(payload));
  const s = crypto.createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${s}`;
}
function verify(token) {
  const [h, p, s] = String(token || "").split(".");
  if (!s) return null;
  const good = crypto.createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url");
  if (good !== s) return null;
  return JSON.parse(Buffer.from(p, "base64url").toString());
}
const now = () => Math.floor(Date.now() / 1000);
export const ANON = sign({ role: "anon", iss: "local", iat: now(), exp: now() + 3600 * 24 * 365 });

function psql(sql) {
  return execFileSync("psql", ["-h", "/var/tmp/pgtest", "-p", "5433", "-U", "postgres", "-d", DB, "-Atq", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" }).trim();
}
function lookupUser(email) {
  const row = psql(`select id from auth.users where lower(email)=lower('${String(email).replace(/'/g, "''")}')`);
  return row || null;
}
function sessionFor(id, email) {
  const exp = now() + 3600;
  const access_token = sign({ sub: id, email, role: "authenticated", aud: "authenticated", iat: now(), exp });
  const user = { id, email, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
  return { access_token, token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: `r-${id}`, user };
}

function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}
function send(res, status, body, headers = {}) {
  const r = res.req || { headers: {} };
  res.writeHead(status, {
    "Access-Control-Allow-Origin": r.headers.origin || "*",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": r.headers["access-control-request-headers"] || "authorization, apikey, content-type, x-client-info, prefer, range, x-upsert",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS, HEAD",
    "Access-Control-Expose-Headers": "content-range, content-type, x-total-count",
    ...headers
  });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === "OPTIONS") return send(res, 204, "");
  const body = await readBody(req);
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const claims = verify(bearer);

  // ---------- REST -> PostgREST ----------
  if (url.pathname.startsWith("/rest/v1/")) {
    const target = PGRST + url.pathname.slice("/rest/v1".length) + url.search;
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (["host", "content-length", "connection", "apikey"].includes(k)) continue;
      headers[k] = v;
    }
    headers.authorization = `Bearer ${claims ? bearer : ANON}`;
    const r = await fetch(target, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
    const out = Buffer.from(await r.arrayBuffer());
    const h = {};
    r.headers.forEach((v, k) => { if (!["content-encoding", "transfer-encoding", "connection"].includes(k) && !k.startsWith("access-control-")) h[k] = v; });
    return send(res, r.status, out, h);
  }

  // ---------- AUTH ----------
  if (url.pathname === "/auth/v1/token") {
    const data = JSON.parse(body.toString() || "{}");
    if (url.searchParams.get("grant_type") === "refresh_token") {
      const id = String(data.refresh_token || "").replace(/^r-/, "");
      const email = psql(`select email from auth.users where id='${id.replace(/'/g, "")}'`);
      return email ? send(res, 200, sessionFor(id, email)) : send(res, 400, { error: "invalid_grant", error_description: "Invalid Refresh Token" });
    }
    const id = lookupUser(data.email || "");
    if (!id || data.password !== PASSWORD) return send(res, 400, { error: "invalid_grant", error_description: "Invalid login credentials" });
    return send(res, 200, sessionFor(id, data.email));
  }
  if (url.pathname === "/auth/v1/user") {
    if (!claims || !claims.sub) return send(res, 401, { msg: "invalid JWT" });
    if (req.method === "PUT") return send(res, 200, { id: claims.sub, email: claims.email, aud: "authenticated" });
    return send(res, 200, { id: claims.sub, email: claims.email, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {} });
  }
  if (url.pathname === "/auth/v1/logout") return send(res, 204, "");
  // Password reset request: real Supabase answers 200 whether or not the
  // e-mail exists (no account enumeration); the mock records the call.
  if (url.pathname === "/auth/v1/recover") {
    fs.appendFileSync(path.join(STORE, "..", "recover.log"), body.toString() + "\n");
    return send(res, 200, {});
  }

  // ---------- STORAGE ----------
  // Mirrors Supabase: /public/ only for public buckets; /authenticated/
  // and signing are checked against storage.objects RLS as the caller
  // (anon when only an apikey is sent).
  const asUser = sql => {
    const sub = claims && claims.sub ? claims.sub.replace(/'/g, "") : "";
    const role = claims && claims.sub ? "authenticated" : "anon";
    return psql(`begin; set local role ${role}; select set_config('request.jwt.claims','{"sub":"${sub}","role":"${role}"}',true); ${sql}; commit;`);
  };
  const q = v => String(v).replace(/'/g, "''");
  const canRead = (bucket, name) => {
    try { return asUser(`select count(*) from storage.objects where bucket_id='${q(bucket)}' and name='${q(name)}'`).endsWith("1"); }
    catch (_) { return false; }
  };
  const serveFile = (bucket, name) => {
    const file = path.join(STORE, bucket, name);
    if (!file.startsWith(STORE) || !fs.existsSync(file)) return send(res, 400, { statusCode: "404", error: "not_found", message: "Object not found" });
    return send(res, 200, fs.readFileSync(file), { "Content-Type": name.endsWith(".png") ? "image/png" : name.endsWith(".webp") ? "image/webp" : "image/jpeg" });
  };
  const signToken = (bucket, name, exp) => crypto.createHmac("sha256", SECRET).update(`${bucket}/${name}/${exp}`).digest("hex") + "." + exp;

  const pub = url.pathname.match(/^\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/);
  if (pub && req.method === "GET") {
    const isPublic = psql(`select public from storage.buckets where id='${q(pub[1])}'`) === "t";
    if (!isPublic) return send(res, 400, { statusCode: "404", error: "not_found", message: "Object not found" });
    return serveFile(pub[1], decodeURIComponent(pub[2]));
  }
  const authd = url.pathname.match(/^\/storage\/v1\/object\/authenticated\/([^/]+)\/(.+)$/);
  if (authd && req.method === "GET") {
    const name = decodeURIComponent(authd[2]);
    if (!canRead(authd[1], name)) return send(res, 400, { statusCode: "404", error: "not_found", message: "Object not found" });
    return serveFile(authd[1], name);
  }
  const signGet = url.pathname.match(/^\/storage\/v1\/object\/sign\/([^/]+)\/(.+)$/);
  if (signGet && req.method === "GET") {
    const name = decodeURIComponent(signGet[2]);
    const tok = url.searchParams.get("token") || "";
    const exp = Number(tok.split(".")[1]);
    if (!exp || exp < now() || signToken(signGet[1], name, exp) !== tok) return send(res, 400, { error: "InvalidSignature" });
    return serveFile(signGet[1], name);
  }
  const signPost = url.pathname.match(/^\/storage\/v1\/object\/sign\/([^/]+)$/);
  if (signPost && req.method === "POST") {
    const { paths = [], expiresIn = 60 } = JSON.parse(body.toString() || "{}");
    const exp = now() + Number(expiresIn);
    return send(res, 200, paths.map(pth => canRead(signPost[1], pth)
      ? { path: pth, signedURL: `/object/sign/${signPost[1]}/${pth}?token=${signToken(signPost[1], pth, exp)}`, error: null }
      : { path: pth, signedURL: null, error: "Either the object does not exist or you do not have access to it" }));
  }
  const up = url.pathname.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/);
  if (up && req.method === "POST") {
    const [bucket, name] = [up[1], decodeURIComponent(up[2])];
    try {
      asUser(`insert into storage.objects(bucket_id,name,owner) values ('${bucket.replace(/'/g, "")}','${name.replace(/'/g, "''")}', ${claims && claims.sub ? `'${claims.sub}'` : "null"})`);
    } catch (e) {
      return send(res, 403, { statusCode: "403", error: "Unauthorized", message: "new row violates row-level security policy" });
    }
    const file = path.join(STORE, bucket, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // supabase-js sends Blob/File uploads as multipart/form-data (the file
    // is the part named ""); real Storage unpacks it, so do the same.
    let bytes = body;
    const ct = req.headers["content-type"] || "";
    const bm = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/);
    if (ct.startsWith("multipart/form-data") && bm) {
      const boundary = Buffer.from("--" + (bm[1] || bm[2]));
      let pos = 0;
      while ((pos = body.indexOf(boundary, pos)) !== -1) {
        const headEnd = body.indexOf("\r\n\r\n", pos);
        if (headEnd === -1) break;
        const head = body.slice(pos, headEnd).toString();
        const next = body.indexOf(boundary, headEnd);
        if (/name=""/.test(head) && next !== -1) { bytes = body.slice(headEnd + 4, next - 2); break; }
        pos = headEnd;
      }
    }
    fs.writeFileSync(file, bytes);
    return send(res, 200, { Key: `${bucket}/${name}` });
  }
  const del = url.pathname.match(/^\/storage\/v1\/object\/([^/]+)$/);
  if (del && req.method === "DELETE") {
    const { prefixes = [] } = JSON.parse(body.toString() || "{}");
    const removed = [];
    for (const name of prefixes) {
      try {
        const n = asUser(`with d as (delete from storage.objects where bucket_id='${del[1]}' and name='${String(name).replace(/'/g, "''")}' returning 1) select count(*) from d`);
        if (n.endsWith("1")) { fs.rmSync(path.join(STORE, del[1], name), { force: true }); removed.push({ name }); }
      } catch (_) { /* denied */ }
    }
    return send(res, 200, removed);
  }

  send(res, 404, { error: "not implemented in mock", path: url.pathname });
});

server.listen(PORT, () => console.log(`mock supabase on :${PORT}  anon=${ANON.slice(0, 20)}…`));
// Optional HTTPS listener so a browser can reach the mock under the real
// Supabase hostname (via --host-resolver-rules) without request rewriting.
if (process.env.TLS_KEY && process.env.TLS_CERT) {
  const handler = server.listeners("request")[0];
  https.createServer({ key: fs.readFileSync(process.env.TLS_KEY), cert: fs.readFileSync(process.env.TLS_CERT) }, handler)
    .listen(Number(process.env.TLS_PORT || 54322), () => console.log("mock supabase TLS on", process.env.TLS_PORT || 54322));
}
