#!/usr/bin/env node
// Speaks one ACP session on stdin/stdout. Not an opencode binary. argv[2] is "acp".
import { appendFileSync } from "node:fs";
const mode = process.env.OPENCODE_PEER_MODE ?? "complete";
if (process.env.OPENCODE_PEER_PID_FILE) appendFileSync(process.env.OPENCODE_PEER_PID_FILE, `${process.pid}\n`);
const sessionId = "session-1";
if (process.argv[2] !== "acp") process.exit(1);

function send(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}
function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}
function text(value) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: {
    sessionUpdate: "agent_message_chunk", messageId: "m", content: { type: "text", text: value },
  } } });
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.length > 0) onLine(line);
    newline = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => {
  if (mode === "linger") setTimeout(() => process.exit(0), 8000);
  else process.exit(0);
});

function onLine(line) {
  const message = JSON.parse(line);
  if (message.id === undefined || message.method === undefined) return;
  if (message.method === "initialize") result(message.id, { protocolVersion: 1 });
  else if (message.method === "session/new") {
    result(message.id, { sessionId, configOptions: [{ id: "model", type: "select", currentValue: "default", options: [] }] });
  } else if (message.method === "session/set_config_option") {
    result(message.id, { configOptions: [{ id: "model", currentValue: message.params.value }] });
  } else if (message.method === "session/close") result(message.id, {});
  else if (message.method === "session/prompt") prompt(message.id);
}

function prompt(id) {
  if (mode === "tool") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: {
      sessionUpdate: "tool_call", title: "SECRET_TOOL", rawInput: { command: "rm -rf SECRET_TOOL" },
    } } });
  } else if (mode === "permission") {
    send({ jsonrpc: "2.0", id: 70, method: "session/request_permission", params: {
      sessionId, options: [{ optionId: "allow", kind: "allow_once" }], path: "/secret/file", command: "bash -c secret-command",
    } });
  } else if (mode === "fs-read" || mode === "fs-write" || mode === "terminal") {
    const method = mode === "fs-read" ? "fs/read_text_file" : mode === "fs-write" ? "fs/write_text_file" : "terminal/create";
    send({ jsonrpc: "2.0", id: 71, method, params: { path: "/secret/file", command: "bash -c secret-command" } });
  } else {
    text("cedar ");
    text("remembered");
  }
  result(id, { stopReason: "end_turn", usage: {} });
}
