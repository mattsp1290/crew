import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const node22 = process.env.CREW_NODE22 ?? process.execPath;
const node24 = process.env.CREW_NODE24;
assert.ok(node24, "Set CREW_NODE24 to the Node 24 binary for the second independent consumer");
function run(program, args, cwd = root) {
  const result = spawnSync(program, args, { cwd, encoding: "utf8", env: { ...process.env, PATH: dirname(program) + ":" + process.env.PATH }, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${program} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
assert.equal(run(node22, ["--version"]).trim(), "v22.23.3");
assert.equal(run(node24, ["--version"]).trim(), "v24.22.3");
const npm = join(dirname(node22), "npm");
run(npm, ["run", "build:client"]);
run(node22, ["scripts/generate-openapi.mjs", "--check"]);
const evidence = await mkdtemp(join(tmpdir(), "crew-client-package-"));
const packed = JSON.parse(run(npm, ["pack", "./packages/client", "--json", "--pack-destination", evidence]));
const tarball = join(evidence, packed[0].filename);
const clientTests = (await readdir(join(root, "tests/client"))).filter(file => file.endsWith(".test.mts")).sort();
assert.ok(clientTests.length > 0, "Portable client tests must be present");
await writeFile(join(evidence, "pack.json"), JSON.stringify(packed, null, 2));
assert.ok(packed[0].files.every(({ path }) => path.startsWith("dist/") || ["README.md", "LICENSE", "package.json", "openapi.json"].includes(path)));
for (const [label, runtime] of [["node22", node22], ["node24", node24]]) {
  const consumer = await mkdtemp(join(tmpdir(), `crew-client-${label}-`));
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: { "@birbcrew/client": tarball } }));
  run(npm, ["install", "--ignore-scripts", "--omit=optional", "--no-audit", "--no-fund"], consumer);
  assert.equal(await readFile(join(consumer, "node_modules/@birbcrew/client/LICENSE"), "utf8"), await readFile(join(root, "packages/client/LICENSE"), "utf8"));
  const installed = JSON.parse(await readFile(join(consumer, "package-lock.json"), "utf8"));
  assert.deepEqual(Object.keys(installed.packages).filter(path => path.startsWith("node_modules/")).sort(), ["node_modules/@birbcrew/client", "node_modules/zod"]);
  for (const file of clientTests) await copyFile(join(root, "tests/client", file), join(consumer, file));
  const output = run(runtime, ["--test", ...clientTests], consumer);
  await writeFile(join(evidence, `${label}-transport.log`), output);
  run(runtime, ["--input-type=module", "-e", `import assert from 'node:assert/strict'; import {CrewClient} from '@birbcrew/client'; assert.equal(typeof CrewClient,'function'); assert.ok(import.meta.resolve('@birbcrew/client/openapi.json').endsWith('/openapi.json')); for(const p of ['@ag-ui/client','@ag-ui/core','pg','@temporalio/client','@openai/codex-sdk','@anthropic-ai/claude-agent-sdk','@mattsp1290/switchboard']) assert.throws(()=>import.meta.resolve(p)); assert.throws(()=>import.meta.resolve('@birbcrew/client/dist/index.js'), {code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});`], consumer);
  await writeFile(join(evidence, `${label}-tree.json`), run(npm, ["ls", "--all", "--json"], consumer));
  if (label === "node22") {
    run(npm, ["install", "--save-dev", "--ignore-scripts", "--no-audit", "--no-fund", "typescript@5.9.3", "esbuild@0.25.12", "@apidevtools/swagger-parser@13.1.0"], consumer);
    const installedOpenApi = join(consumer, "node_modules/@birbcrew/client/openapi.json");
    assert.equal(await readFile(installedOpenApi, "utf8"), await readFile(join(root, "packages/client/openapi.json"), "utf8"), "packed OpenAPI matches the generated source");
    await copyFile(installedOpenApi, join(consumer, "openapi.json"));
    await writeFile(join(evidence, "openapi-validation.log"), run(runtime, ["--input-type=module", "-e", "import SwaggerParser from '@apidevtools/swagger-parser'; await SwaggerParser.validate('openapi.json'); console.log('OpenAPI 3.1 validates');"], consumer));
    await writeFile(join(consumer, "browser.ts"), `import {CrewClient, CrewUnknownOutcomeError, type CommandIdentity, type HandoffCommandIdentity, type CreateHandoff, type CreateHandoffResponse, type ConversationHandoff, type HandoffRecord, type HandoffsCapability, type HandoffsCapabilityV1, type RequestReceipt, type OwnerApprovalDetail, type ApprovalDetailIdentity, type RecordWorkItemArguments, type GrantList, type ListGrants, type RevokeGrant, type RevokeGrantResponse, type PublicGrant, type ConversationContentTombstone, type ConversationClosure} from '@birbcrew/client';
import {createHandoffBodySchema, createHandoffSchema, handoffRecordSchema, createHandoffResponseSchema, conversationHandoffSchema, handoffsCapabilityV1Schema, handoffsCapabilitySchema, type CreateHandoff as ContractCreateHandoff, type CreateHandoffResponse as ContractCreateHandoffResponse, type ConversationHandoff as ContractConversationHandoff, type HandoffRecord as ContractHandoffRecord, type HandoffsCapability as ContractHandoffsCapability, type HandoffsCapabilityV1 as ContractHandoffsCapabilityV1, type GrantList as ContractGrantList, type PublicGrant as ContractGrant, type OwnerApprovalDetail as ContractDetail, type RequestReceipt as ContractReceipt, type ServerRequestReceipt} from '@birbcrew/client/contract';
export const fromContract = (receipt: ContractReceipt): RequestReceipt => receipt;
export const toContract = (receipt: RequestReceipt): ContractReceipt => receipt;
export const fromServer = (receipt: ServerRequestReceipt): RequestReceipt => receipt;
const client = new CrewClient({baseUrl:'https://crew.example', token:'token'});
export const read = () => client.listMembers();
export const eraseContent = (conversationId: string): Promise<ConversationContentTombstone> => client.eraseConversationContent({conversationId});
export const closeConversation = (conversationId: string): Promise<ConversationClosure> => client.closeConversation({conversationId});
export const completedSubmitText = async (conversationId: string, requestId: string) => {
 const receipt=await client.submit({conversationId,requestId,text:'fixture'});
 if(receipt.status==='completed') return receipt.result.text;
};
export const createHandoff = (key: CreateHandoff): Promise<CreateHandoffResponse> => client.createHandoff(key);
export const handoff = (conversationId: string): Promise<ConversationHandoff> => client.handoff({conversationId});
export const handoffInputFromContract = (value: ContractCreateHandoff): CreateHandoff => value;
export const handoffInputToContract = (value: CreateHandoff): ContractCreateHandoff => value;
export const handoffResponseFromContract = (value: ContractCreateHandoffResponse): CreateHandoffResponse => value;
export const handoffResponseToContract = (value: CreateHandoffResponse): ContractCreateHandoffResponse => value;
export const handoffChainFromContract = (value: ContractConversationHandoff): ConversationHandoff => value;
export const handoffChainToContract = (value: ConversationHandoff): ContractConversationHandoff => value;
export const handoffRecordFromContract = (value: ContractHandoffRecord): HandoffRecord => value;
export const handoffRecordToContract = (value: HandoffRecord): ContractHandoffRecord => value;
export const handoffsCapabilityFromContract = (value: ContractHandoffsCapability): HandoffsCapability => value;
export const handoffsCapabilityToContract = (value: HandoffsCapability): ContractHandoffsCapability => value;
export const handoffsV1FromContract = (value: ContractHandoffsCapabilityV1): HandoffsCapabilityV1 => value;
export const handoffsV1ToContract = (value: HandoffsCapabilityV1): ContractHandoffsCapabilityV1 => value;
export const parseHandoffBody = (value: unknown) => createHandoffBodySchema.parse(value);
export const parseHandoffInput = (value: unknown): CreateHandoff => createHandoffSchema.parse(value);
export const parseHandoffRecord = (value: unknown): HandoffRecord => handoffRecordSchema.parse(value);
export const parseHandoffResponse = (value: unknown): CreateHandoffResponse => createHandoffResponseSchema.parse(value);
export const parseHandoffChain = (value: unknown): ConversationHandoff => conversationHandoffSchema.parse(value);
export const parseHandoffsCapability = (value: unknown): HandoffsCapability => handoffsCapabilitySchema.parse(value);
export const parseSupportedHandoffs = (value: unknown): HandoffsCapabilityV1 => handoffsCapabilityV1Schema.parse(value);
export function savedHandoff(error: unknown): HandoffCommandIdentity | undefined {
  if (error instanceof CrewUnknownOutcomeError && error.command.kind === 'handoff') return error.command;
}
export const handoffCommand = (value: HandoffCommandIdentity): CommandIdentity => value;
export const grants = (key: ListGrants): Promise<GrantList> => client.listGrants(key);
export const revoke = (key: RevokeGrant): Promise<RevokeGrantResponse> => client.revokeGrant(key);
export const grantsFromContract = (value: ContractGrantList): GrantList => value;
export const grantFromContract = (value: ContractGrant): PublicGrant => value;
// @ts-expect-error conversation grants require a conversation identity
const invalidGrant: PublicGrant = {grantId:'id', memberId:'id', toolName:'record_work_item', policyVersion:1, approvalId:'id', createdAt:'time', scope:'conversation', conversationId:null, choice:'allow_conversation', status:'active'};
export const detail = (key: ApprovalDetailIdentity): Promise<OwnerApprovalDetail> => client.approvalDetail(key);
export const detailFromContract = (value: ContractDetail): OwnerApprovalDetail => value;
export const completeArguments = (value: OwnerApprovalDetail): RecordWorkItemArguments => value.arguments;
export function result(receipt: RequestReceipt): string | undefined { if (receipt.status === 'completed' && !receipt.erased) return receipt.result.text; }
// @ts-expect-error completed receipts require result
const invalid: RequestReceipt = {apiVersion:'1',conversationId:'id',requestId:'id',acceptance:{boundary:'sql_admission_and_temporal_queue'},status:'completed'};
// @ts-expect-error owner identity comes only from bearer authentication
client.submit({ownerId:'other',conversationId:'id',requestId:'id',text:'x'});
`);
    await writeFile(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", strict: true, noEmit: true, types: [], lib: ["ES2022", "DOM"] }, files: ["browser.ts"] }));
    run(runtime, ["node_modules/typescript/bin/tsc"], consumer);
    await writeFile(join(consumer, "bundle.mjs"), `import {build} from 'esbuild'; import {writeFile} from 'node:fs/promises'; const output = await build({entryPoints:['browser.ts'],bundle:true,platform:'browser',format:'esm',write:false,metafile:true}); await writeFile('bundle-meta.json',JSON.stringify(output.metafile));`);
    run(runtime, ["bundle.mjs"], consumer);
    const graph = JSON.parse(await readFile(join(consumer, "bundle-meta.json"), "utf8"));
    assert.ok(Object.keys(graph.inputs).every(path => path === "browser.ts" || path.startsWith("node_modules/zod/") || path.startsWith("node_modules/@birbcrew/client/dist/")));
    const dist = join(consumer, "node_modules/@birbcrew/client/dist");
    for (const file of await readdir(dist)) {
      if (file.startsWith("agui.")) continue;
      assert.doesNotMatch(await readFile(join(dist, file), "utf8"), /(?:from\s*["']|import\(["'])(?:node:|pg["']|@temporalio|@ag-ui|@openai|@anthropic|@mattsp1290)/);
    }
    run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", "@ag-ui/client@1.0.4", "@ag-ui/core@1.0.4"], consumer);
    run(runtime, ["--input-type=module", "-e", `import assert from 'node:assert/strict'; import {HttpAgent} from '@ag-ui/client'; import {createCrewObserver} from '@birbcrew/client/agui'; assert.ok(createCrewObserver({baseUrl:'https://crew.example',token:'token',conversationId:'b5c4af2a-5f44-4a78-a778-529c785753e6'}) instanceof HttpAgent);`], consumer);
  }
  console.log(`${label}: independently installed transport tests, root isolation and private-export protection passed (${consumer})`);
}
console.log(`Client tarball: ${tarball}\nEvidence: ${evidence}`);
