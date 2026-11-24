import assert from "node:assert/strict";
import test from "node:test";
import { boundedText, validRequestTextSchema, requestTextBytesSchema } from "@birbcrew/client/contract";
import { readLiveProfiles } from "../../src/service/accounts.ts";
import { cursorProfileSchema, opencodeProfileSchema, storedRequestTextBytes } from "../../src/service/text-profile-validation.ts";

const cursor = { model: "composer-2", apiKey: "synthetic-key", cwd: "/tmp" };
const opencode = { model: "provider/model", executable: "/tmp/opencode", cwd: "/tmp", account: "label", env: { TOKEN: "synthetic-value" } };
test("module and live profiles agree on shared model/path fields and do not print values", () => {
  for (const engine of ["cursor", "opencode"] as const) {
    const schema = engine === "cursor" ? cursorProfileSchema : opencodeProfileSchema;
    const runtime = engine === "cursor" ? cursor : opencode;
    const live = { account: " label ", model: runtime.model, cwd: runtime.cwd,
      ...(engine === "opencode" ? { executable: opencode.executable, env: ["TOKEN"] } : {}) };
    assert.equal(readLiveProfiles({ BIRBCREW_LIVE_PROFILES: JSON.stringify({ [engine]: live }) })[engine]?.account, "label");
    for (const bad of ["", " model", "model ", "bad\nsecret-marker", "bad\u0085", "bad\ud800"]) {
      assert.equal(schema.safeParse({ ...runtime, model: bad }).success, false);
      assert.throws(() => readLiveProfiles({ BIRBCREW_LIVE_PROFILES: JSON.stringify({ [engine]: { ...live, model: bad } }) }),
        (error: Error) => error.message.includes(`${engine}.model`) && !error.message.includes("secret-marker"));
    }
    for (const cwd of ["relative", "/tmp/../tmp", "/tmp/", "/tmp/\0hidden"]) {
      assert.equal(schema.safeParse({ ...runtime, cwd }).success, false);
      assert.throws(() => readLiveProfiles({ BIRBCREW_LIVE_PROFILES: JSON.stringify({ [engine]: { ...live, cwd } }) }));
    }
    assert.equal(schema.safeParse({ ...runtime, unsupported: true }).success, false);
  }
  for (const apiKey of ["", " key", "key\n", "x".repeat(513)]) assert.equal(cursorProfileSchema.safeParse({ ...cursor, apiKey }).success, false);
  for (const env of [{ "NOT VALID": "x" }, { TOKEN: "x\n" }, null, []]) assert.equal(opencodeProfileSchema.safeParse({ ...opencode, env }).success, false);
  assert.equal(cursorProfileSchema.safeParse({ ...cursor, runtime() {} }).success, true);
  assert.equal(opencodeProfileSchema.safeParse({ ...opencode, spawn() {} }).success, true);
});
test("request text preserves the baseline validity corpus and counts UTF-8 bytes", () => {
  const baseline = (text: string) => text.length > 0 && !text.includes("\0") && text.isWellFormed() && new TextEncoder().encode(text).length <= 16_384;
  for (const text of ["", "\0", "\ud800", "\udc00", "\ufffd", "\uffff", "\t\n\r", "\u0001", "\u0085", "é".repeat(8192), "é".repeat(8192) + "x"]) {
    assert.equal(boundedText(16_384).safeParse(text).success, baseline(text));
    assert.equal(validRequestTextSchema.safeParse(text).success, text.length > 0 && !text.includes("\0") && text.isWellFormed());
  }
});
test("configuration and stored policy have distinct error boundaries", () => {
  for (const value of [0, 16_383, 65_537, 1.5, null, "65536"]) {
    assert.equal(requestTextBytesSchema.safeParse(value).success, false);
    assert.throws(() => storedRequestTextBytes(value), { name: "Error", message: "Invalid stored request-text policy" });
  }
  for (const value of [16_384, 32_768, 65_536]) assert.equal(storedRequestTextBytes(value), value);
});

test("live construction carries policy outside SDK options", async () => {
  const { loadLiveProfiles } = await import("../../src/service/live-profiles.ts");
  const profiles = await loadLiveProfiles({
    BIRBCREW_LIVE_PROFILES: JSON.stringify({
      cursor: { account: "cursor", model: cursor.model, cwd: cursor.cwd, requestTextBytes: 32_768 },
      opencode: { account: "opencode", model: opencode.model, cwd: opencode.cwd, executable: opencode.executable, env: ["TOKEN"], requestTextBytes: 65_536 },
    }), BIRBCREW_CURSOR_API_KEY: "synthetic", TOKEN: "synthetic",
  });
  assert.equal(profiles.get("cursor.v1")?.requestTextBytes, 32_768);
  assert.equal(profiles.get("opencode.v1")?.requestTextBytes, 65_536);
  assert.equal(Object.hasOwn(profiles.get("cursor.v1")!.cursor!, "requestTextBytes"), false);
  assert.equal(Object.hasOwn(profiles.get("cursor.v1")!.cursor!, "runtime"), false);
  assert.equal(Object.hasOwn(profiles.get("opencode.v1")!.opencode!, "requestTextBytes"), false);
});
