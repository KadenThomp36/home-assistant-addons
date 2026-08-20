// T3 Code HA ingress proxy
// -------------------------------------------------------------------------
// Sits between Home Assistant ingress and the loopback `t3 serve`. Two jobs:
//
//   1. AUTH: HA ingress has already authenticated the user (HA login) before it
//      ever reaches us. T3's server, however, requires a session credential on
//      its data plane (/api/* + WebSocket) — there is no loopback bypass. So we
//      inject `Authorization: Bearer <token>` plus the session cookie on every
//      proxied HTTP request and WS upgrade. The bearer is minted once by run.sh
//      via `t3 auth session issue` and read from T3_BEARER_FILE. The token never
//      reaches the browser. T3 ≥0.0.33 scopes its session cookie name per
//      instance (`t3_session_<port>_<id>`), so the cookie name can't be
//      hardcoded — it's discovered from upstream `/api/auth/session` metadata.
//
//   2. INGRESS BASE PATH: HA serves the add-on under /api/hassio_ingress/<token>/
//      and passes that prefix in the `X-Ingress-Path` header (it strips the prefix
//      before forwarding, so upstream paths are already root-relative). We rewrite
//      the *static* root-absolute asset refs in index.html (`src="/assets/..."`),
//      and — because T3 ≥0.0.33's SPA resolves its API/WS base from
//      window.location.origin ONLY (resolvePrimaryEnvironmentHttpUrl overwrites
//      the pathname, so the ingress sub-path is discarded and every call lands on
//      HA core → 404) — we also inject a shim into index.html that patches
//      fetch/WebSocket/EventSource to re-prefix same-host requests with the
//      ingress path.
// -------------------------------------------------------------------------

import http from "node:http";
import net from "node:net";
import fs from "node:fs";

const UPSTREAM_HOST = "127.0.0.1";
const UPSTREAM_PORT = Number(process.env.T3_UPSTREAM_PORT || 3774);
const LISTEN_PORT = Number(process.env.T3_PROXY_PORT || 3773);
const BEARER_FILE = process.env.T3_BEARER_FILE || "/data/t3code/.ingress-bearer";

function readBearer() {
  try {
    return fs.readFileSync(BEARER_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

// Cache the bearer but re-read if the file changes (run.sh may re-mint on expiry).
let BEARER = readBearer();
try {
  fs.watchFile(BEARER_FILE, { interval: 5000 }, () => {
    const next = readBearer();
    if (next) BEARER = next;
  });
} catch {
  /* best effort */
}

// Instance-scoped session cookie name (e.g. t3_session_3774_ab12cd34ef56),
// discovered from the upstream auth metadata. Empty until discovery succeeds;
// the bearer Authorization header carries auth on its own in the meantime.
let COOKIE_NAME = "";
function discoverCookieName(attempt = 0) {
  http
    .get(
      { host: UPSTREAM_HOST, port: UPSTREAM_PORT, path: "/api/auth/session" },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const name = JSON.parse(Buffer.concat(chunks).toString("utf8"))
              ?.auth?.sessionCookieName;
            if (name) {
              COOKIE_NAME = name;
              console.log(`[t3code-proxy] session cookie name: ${COOKIE_NAME}`);
              return;
            }
          } catch {
            /* fall through to retry */
          }
          if (attempt < 30) setTimeout(() => discoverCookieName(attempt + 1), 2000);
        });
      },
    )
    .on("error", () => {
      if (attempt < 30) setTimeout(() => discoverCookieName(attempt + 1), 2000);
    });
}
discoverCookieName();

function cookieHeader(existing) {
  if (!COOKIE_NAME) return existing || "";
  const inject = `${COOKIE_NAME}=${BEARER}`;
  return existing ? `${existing}; ${inject}` : inject;
}

// Injected into index.html <head>. Re-prefixes same-host fetch/WebSocket/
// EventSource requests with the ingress path the SPA discarded (see header
// comment). Runs before any app code; no-op outside an ingress context.
const INGRESS_SHIM = `<script>(() => {
  const m = location.pathname.match(/^\\/api\\/hassio_ingress\\/[^/]+/);
  if (!m) return;
  const prefix = m[0];
  const rewrite = (raw) => {
    try {
      const url = new URL(raw, location.href);
      if (
        /^(https?|wss?):$/.test(url.protocol) &&
        url.host === location.host &&
        url.pathname !== prefix &&
        !url.pathname.startsWith(prefix + "/")
      ) {
        url.pathname = prefix + url.pathname;
        return url.toString();
      }
    } catch {}
    return raw;
  };
  const origFetch = window.fetch.bind(window);
  window.fetch = (input, init) =>
    input instanceof Request
      ? origFetch(new Request(rewrite(input.url), input), init)
      : origFetch(rewrite(String(input)), init);
  const OrigWS = window.WebSocket;
  const PatchedWS = function (url, protocols) {
    return protocols === undefined
      ? new OrigWS(rewrite(String(url)))
      : new OrigWS(rewrite(String(url)), protocols);
  };
  PatchedWS.prototype = OrigWS.prototype;
  Object.setPrototypeOf(PatchedWS, OrigWS);
  window.WebSocket = PatchedWS;
  if (window.EventSource) {
    const OrigES = window.EventSource;
    const PatchedES = function (url, cfg) {
      return new OrigES(rewrite(String(url)), cfg);
    };
    PatchedES.prototype = OrigES.prototype;
    Object.setPrototypeOf(PatchedES, OrigES);
    window.EventSource = PatchedES;
  }
})();</script>`;

// Defensive: HA already strips the ingress prefix, but if a request still carries
// it (direct access, older HA), strip it so upstream sees a root-relative path.
function upstreamPath(url, prefix) {
  if (prefix && url.startsWith(prefix)) {
    return url.slice(prefix.length) || "/";
  }
  return url;
}

const server = http.createServer((creq, cres) => {
  const prefix = creq.headers["x-ingress-path"] || "";
  const path = upstreamPath(creq.url, prefix);

  const headers = { ...creq.headers };
  headers.host = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`;
  headers.authorization = `Bearer ${BEARER}`;
  const cookie = cookieHeader(creq.headers.cookie);
  if (cookie) headers.cookie = cookie;
  else delete headers.cookie;
  // Force identity encoding so we can rewrite text/html bodies reliably.
  delete headers["accept-encoding"];

  const preq = http.request(
    { host: UPSTREAM_HOST, port: UPSTREAM_PORT, method: creq.method, path, headers },
    (pres) => {
      const ctype = String(pres.headers["content-type"] || "");
      const isHtml = ctype.includes("text/html") && prefix;

      if (!isHtml) {
        cres.writeHead(pres.statusCode || 502, pres.headers);
        pres.pipe(cres);
        return;
      }

      // Buffer + rewrite HTML: prefix the root-absolute static asset refs so the
      // browser fetches them under the ingress path instead of the HA root.
      const chunks = [];
      pres.on("data", (c) => chunks.push(c));
      pres.on("end", () => {
        let body = Buffer.concat(chunks).toString("utf8");
        body = body
          .replaceAll('src="/', `src="${prefix}/`)
          .replaceAll('href="/', `href="${prefix}/`)
          .replaceAll('"/assets/', `"${prefix}/assets/`)
          .replace(/<head>/i, `<head>${INGRESS_SHIM}`);
        const outHeaders = { ...pres.headers };
        delete outHeaders["content-length"];
        cres.writeHead(pres.statusCode || 200, outHeaders);
        cres.end(body);
      });
    },
  );

  preq.on("error", (e) => {
    cres.writeHead(502, { "content-type": "text/plain" });
    cres.end(`t3code ingress proxy: upstream error: ${e.message}\n`);
  });
  creq.pipe(preq);
});

// WebSocket upgrades: raw TCP splice to upstream with the session cookie injected.
server.on("upgrade", (creq, csock, head) => {
  const prefix = creq.headers["x-ingress-path"] || "";
  const path = upstreamPath(creq.url, prefix);

  const up = net.connect(UPSTREAM_PORT, UPSTREAM_HOST, () => {
    let raw = `${creq.method} ${path} HTTP/1.1\r\n`;
    raw += `host: ${UPSTREAM_HOST}:${UPSTREAM_PORT}\r\n`;
    for (const [k, v] of Object.entries(creq.headers)) {
      if (k === "cookie" || k === "host" || k === "authorization") continue;
      raw += `${k}: ${v}\r\n`;
    }
    raw += `authorization: Bearer ${BEARER}\r\n`;
    const cookie = cookieHeader(creq.headers.cookie);
    if (cookie) raw += `cookie: ${cookie}\r\n`;
    raw += `\r\n`;
    up.write(raw);
    if (head && head.length) up.write(head);
    up.pipe(csock);
    csock.pipe(up);
  });
  up.on("error", () => csock.destroy());
  csock.on("error", () => up.destroy());
});

server.listen(LISTEN_PORT, "0.0.0.0", () => {
  console.log(
    `[t3code-proxy] listening on 0.0.0.0:${LISTEN_PORT} -> ${UPSTREAM_HOST}:${UPSTREAM_PORT}` +
      ` (bearer ${BEARER ? "loaded" : "MISSING"})`,
  );
});
