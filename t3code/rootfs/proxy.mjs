// T3 Code HA ingress proxy
// -------------------------------------------------------------------------
// Sits between Home Assistant ingress and the loopback `t3 serve`. Two jobs:
//
//   1. AUTH: HA ingress has already authenticated the user (HA login) before it
//      ever reaches us. T3's server, however, requires a session credential on
//      its data plane (/api/* + WebSocket) — there is no loopback bypass. So we
//      inject `Authorization: Bearer <token>` on every proxied HTTP request and
//      WS upgrade. The bearer is minted once by run.sh via `t3 auth session issue`
//      and read from T3_BEARER_FILE. The token never reaches the browser.
//      Do NOT also send it as the `t3_session_*` cookie: for requests carrying a
//      browser Origin, T3 validates that cookie as a browser session, and a bearer
//      token in it fails with 401 invalid_credential (every API call and the /ws
//      upgrade -> "Still connecting"). Any t3_session_* cookie from the browser is
//      stripped for the same reason.
//
//   2. INGRESS BASE PATH: HA serves the add-on under /api/hassio_ingress/<token>/
//      and passes that prefix in the `X-Ingress-Path` header (it strips the prefix
//      before forwarding, so upstream paths are already root-relative). We rewrite
//      the *static* root-absolute asset refs in index.html (`src="/assets/..."`),
//      and — because T3 ≥0.0.33's SPA resolves its API/WS base from
//      window.location.origin ONLY (resolvePrimaryEnvironmentHttpUrl overwrites
//      the pathname, so the ingress sub-path is discarded and every call lands on
//      HA core → 404) — we also inject a shim into index.html that patches
//      fetch/WebSocket/EventSource, plus <link href>/<script src> (Vite's
//      root-based preloads), to re-prefix same-host requests with the ingress path.
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

// Forward the browser's cookies minus any T3 session cookie (see header comment).
function cookieHeader(existing) {
  return String(existing || "")
    .split(/;\s*/)
    .filter((c) => c && !/^t3_session_/.test(c))
    .join("; ");
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
  // Vite's preload helper builds dependency URLs as "/" + "assets/x" (base is
  // baked in at build time) and assigns them to <link rel=modulepreload|stylesheet>
  // href. Without this they hit HA's root and 404; a failed CSS preload rejects
  // and the SPA dies with "T3 Code failed to start".
  for (const [El, prop] of [[HTMLLinkElement, "href"], [HTMLScriptElement, "src"]]) {
    const d = Object.getOwnPropertyDescriptor(El.prototype, prop);
    if (d && d.set) {
      Object.defineProperty(El.prototype, prop, {
        ...d,
        set(v) { d.set.call(this, rewrite(String(v))); },
      });
    }
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
  // Stylesheets are rewritten (below); a 304 would make the browser keep a copy
  // cached before the rewrite existed, with fonts still pointing at HA's root.
  if (prefix && /\.css(\?|$)/.test(path)) {
    delete headers["if-none-match"];
    delete headers["if-modified-since"];
  }

  const preq = http.request(
    { host: UPSTREAM_HOST, port: UPSTREAM_PORT, method: creq.method, path, headers },
    (pres) => {
      const ctype = String(pres.headers["content-type"] || "");
      const isHtml = ctype.includes("text/html") && prefix;
      const isCss = ctype.includes("text/css") && prefix;

      if (isCss) {
        // Stylesheets reference fonts as url(/assets/...), which resolves against
        // HA's root, not the stylesheet. Prefix them like the HTML refs below.
        const chunks = [];
        pres.on("data", (c) => chunks.push(c));
        pres.on("end", () => {
          const body = Buffer.concat(chunks)
            .toString("utf8")
            .replace(/url\((["']?)\/assets\//g, `url($1${prefix}/assets/`);
          const outHeaders = { ...pres.headers };
          delete outHeaders["content-length"];
          delete outHeaders["etag"];
          delete outHeaders["last-modified"];
          cres.writeHead(pres.statusCode || 200, outHeaders);
          cres.end(body);
        });
        return;
      }

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
