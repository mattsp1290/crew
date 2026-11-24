import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import { cursorPolicyProbeToken } from "./cursor-policy-support.ts";

// This short-lived process checks exports. Import-time network activity is unsupported.
const deny = (): never => { throw new Error("cursor_policy_unsupported"); };
http.request = deny;
http.get = deny;
https.request = deny;
https.get = deny;
http2.connect = deny;
net.Socket.prototype.connect = deny;
tls.connect = deny;
globalThis.fetch = deny;
syncBuiltinESMExports();

try {
  const sdk = await import("@cursor/sdk");
  const adapter = await import("@operatorworks/switchboard/cursor");
  for (const method of [adapter.createCursorTextRuntime, sdk.Agent?.create, sdk.Agent?.resume,
    sdk.emptyFs, sdk.JsonlLocalAgentStore, sdk.Cursor?.models?.list]) {
    if (typeof method !== "function") deny();
  }
  Reflect.construct(Object, [], sdk.JsonlLocalAgentStore);
  const tree = sdk.emptyFs();
  if (tree === null || typeof tree !== "object"
    || [tree.read, tree.list, tree.write, tree.delete].some((method) => typeof method !== "function")) deny();
  process.stdout.write(cursorPolicyProbeToken);
} catch {
  process.exitCode = 1;
}
