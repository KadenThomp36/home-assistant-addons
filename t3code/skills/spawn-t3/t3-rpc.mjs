#!/usr/bin/env node
// t3-rpc.mjs — call one T3 Code WebSocket RPC method and print its result as JSON.
// Part of the `spawn-t3` skill. T3 v0.1.0 (Orchestrator V2) removed the HTTP
// `/api/orchestration/dispatch` endpoint; orchestration commands now go over the
// same Effect-RPC WebSocket the web UI uses (JSON serialization, `/ws`).
//
// Usage: node t3-rpc.mjs <base_url> <bearer_token> <method> <payload_json>
//   e.g. node t3-rpc.mjs http://127.0.0.1:3773 "$TOK" orchestration.dispatchCommand '{...}'
// Exit 0 + result JSON on stdout on success; exit 1 + error on stderr otherwise.
//
// Wire protocol (effect/unstable/rpc, RpcSerialization.layerJson):
//   -> {"_tag":"Request","id":"1","tag":<method>,"payload":<payload>,"headers":[]}
//   <- {"_tag":"Exit","requestId":"1","exit":{"_tag":"Success","value":...}}
//      or exit {"_tag":"Failure","cause":[...]}; the server may also send Pings.
// The upgrade URL must carry `orchestrationProtocol=2` or the server refuses it.

const ORCHESTRATION_PROTOCOL_VERSION = "2";
const TIMEOUT_MS = 30_000;

const [baseUrl, token, method, payloadJson] = process.argv.slice(2);
if (!baseUrl || !token || !method || payloadJson === undefined) {
  console.error("usage: t3-rpc.mjs <base_url> <bearer_token> <method> <payload_json>");
  process.exit(2);
}

const fail = (msg) => {
  console.error(`t3-rpc: ${msg}`);
  process.exit(1);
};

const payload = JSON.parse(payloadJson);

const ticketRes = await fetch(new URL("/api/auth/websocket-ticket", baseUrl), {
  method: "POST",
  headers: { authorization: `Bearer ${token}` },
});
if (!ticketRes.ok) fail(`websocket-ticket HTTP ${ticketRes.status}: ${await ticketRes.text()}`);
const { ticket } = await ticketRes.json();

const wsUrl = new URL("/ws", baseUrl);
wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
wsUrl.searchParams.set("wsTicket", ticket);
wsUrl.searchParams.set("orchestrationProtocol", ORCHESTRATION_PROTOCOL_VERSION);
wsUrl.searchParams.set("clientSurface", "web");

const ws = new WebSocket(wsUrl);
const timer = setTimeout(() => fail(`timed out after ${TIMEOUT_MS}ms waiting for ${method}`), TIMEOUT_MS);

ws.addEventListener("open", () => {
  ws.send(JSON.stringify({ _tag: "Request", id: "1", tag: method, payload, headers: [] }));
});
ws.addEventListener("message", (event) => {
  const msgs = [].concat(JSON.parse(String(event.data)));
  for (const msg of msgs) {
    if (msg._tag === "Ping") {
      ws.send(JSON.stringify({ _tag: "Pong" }));
    } else if (msg._tag === "Exit" && msg.requestId === "1") {
      clearTimeout(timer);
      ws.close();
      if (msg.exit?._tag === "Success") {
        console.log(JSON.stringify(msg.exit.value ?? null));
        process.exit(0);
      }
      fail(`${method} failed: ${JSON.stringify(msg.exit)}`);
    } else if (msg._tag === "Defect" || msg._tag === "ClientProtocolError") {
      fail(`protocol error: ${JSON.stringify(msg)}`);
    }
  }
});
ws.addEventListener("error", (event) => fail(`websocket error: ${event.message ?? "connection failed"}`));
ws.addEventListener("close", (event) => fail(`websocket closed (${event.code}) before ${method} returned`));
