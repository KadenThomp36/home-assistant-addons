// T3 Code HA ingress proxy
// -------------------------------------------------------------------------
// Sits between Home Assistant ingress and the loopback `t3 serve`. Two jobs:
//
//   1. AUTH: HA ingress has already authenticated the user (HA login) before it
//      ever reaches us. T3's server, however, requires a session credential on
//      its data plane (/api/* + WebSocket) — there is no loopback bypass. So we
//      inject `Cookie: t3_session=<bearer>` on every proxied HTTP request and WS
//      upgrade. The bearer is minted once by run.sh via `t3 auth session issue`
//      and read from T3_BEARER_FILE. The token never reaches the browser.
//
//   2. INGRESS BASE PATH: HA serves the add-on under /api/hassio_ingress/<token>/
//      and passes that prefix in the `X-Ingress-Path` header (it strips the prefix
//      before forwarding, so upstream paths are already root-relative). T3's SPA
//      derives its own API/WS base from location.pathname, so its runtime calls
//      follow the prefix automatically — we only need to rewrite the *static*
//      root-absolute asset refs in index.html (`src="/assets/..."` etc).
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

function cookieHeader(existing) {
  const inject = `t3_session=${BEARER}`;
  return existing ? `${existing}; ${inject}` : inject;
}

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
  headers.cookie = cookieHeader(creq.headers.cookie);
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
          .replaceAll('"/assets/', `"${prefix}/assets/`);
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
      if (k === "cookie" || k === "host") continue;
      raw += `${k}: ${v}\r\n`;
    }
    raw += `cookie: ${cookieHeader(creq.headers.cookie)}\r\n\r\n`;
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
