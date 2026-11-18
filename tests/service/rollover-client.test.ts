import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ApplicationFailure, WorkflowUpdateFailedError, type Client } from "@temporalio/client";
import { MemberClient } from "../../src/service/client.ts";
import type { MemberStore } from "../../src/service/store.ts";
import type { Conversation } from "../../src/service/domain.ts";

function fixture(reply?: string) {
  const conversation: Conversation = { ownerId:"owner", memberId:randomUUID(), conversationId:randomUUID(), engine:"pi", profile:"test" };
  const request = {ownerId:conversation.ownerId,conversationId:conversation.conversationId,requestId:randomUUID(),text:"hello"};
  const routes: unknown[][] = [];
  const calls: string[] = [];
  const checks: string[] = [];
  let failures = 0;
  const store = {requestAdmission:async()=>undefined,checkAdmission:async()=>{checks.push(request.requestId);},getConversation:async () => conversation, workflowRunId:async () => "persisted-first-run", committedReply:async () => reply} as unknown as MemberStore;
  const temporal = { workflow:{ getHandle:(...args:unknown[]) => {
    routes.push(args);
    return {executeUpdate: async (name:string) => {
      calls.push(name);
      if (failures++ === 0) throw new WorkflowUpdateFailedError("rejected", ApplicationFailure.nonRetryable("rolling", "RolloverInProgress"));
      return name === "acceptTurn" ? request.requestId : "reply";
    }};
  }}} as unknown as Client;
  return {client:new MemberClient(store,temporal), request,routes,calls,checks};
}

test("admission retries only rollover rejection and routes by logical workflow, never stored first run", async () => {
  const f=fixture();
  assert.deepEqual(await f.client.accept(f.request),{requestId:f.request.requestId});
  assert.deepEqual(f.calls,["acceptTurn","acceptTurn"]);
  assert.equal(f.checks.length,2,"admission is checked again before every attempt");
  assert.equal(f.routes.length,2);
  for (const args of f.routes) assert.equal(args.length,1);
});

test("synchronous submission follows rollover to latest run", async () => {
  const f=fixture();
  assert.equal(await f.client.submit(f.request),"reply");
  assert.deepEqual(f.calls,["submitTurn","submitTurn"]);
  for (const args of f.routes) assert.equal(args.length,1);
});

test("earlier generation committed requests never address a workflow", async () => {
  const f=fixture("committed");
  assert.equal(await f.client.submit(f.request),"committed");
  assert.deepEqual(await f.client.accept(f.request),{requestId:f.request.requestId});
  assert.deepEqual(f.routes,[]);
});

test("unknown accepted-update outcomes are not retried", async () => {
  const f=fixture();
  const store = {requestAdmission:async()=>undefined,checkAdmission:async()=>{},getConversation:async () => ({}), workflowRunId:async () => "run", committedReply:async () => undefined} as unknown as MemberStore;
  let calls=0;
  const error = new Error("transport lost after acceptance");
  const temporal={workflow:{getHandle:()=>({executeUpdate:async()=>{calls++;throw error;}})}} as unknown as Client;
  await assert.rejects(new MemberClient(store,temporal).accept(f.request),error);
  assert.equal(calls,1);
});

// Pure boundary calculation stays independent of workflow runtime and network calls.
test("history rollover triggers at finite event cap or Temporal server suggestion", async () => {
  const { historyRequiresRollover, workflowHistoryEventLimit } = await import("../../src/service/limits.ts");
  assert.equal(historyRequiresRollover({historyLength:workflowHistoryEventLimit-1,continueAsNewSuggested:false}),false);
  assert.equal(historyRequiresRollover({historyLength:workflowHistoryEventLimit,continueAsNewSuggested:false}),true);
  assert.equal(historyRequiresRollover({historyLength:1,continueAsNewSuggested:true}),true);
});

test("status reconciles only a confirmed terminal logical run without starting work", async()=>{
  const f=fixture(); let phase="accepted",reason:string|undefined,terminal="RUNNING",repairs=0,describes=0;
  const conversation={...f.request,memberId:randomUUID(),engine:"pi",profile:"fixture"};
  const store={getConversation:async()=>conversation,requestStatus:async()=>({requestId:f.request.requestId,phase,...(reason?{reason}:{})}),
    rejectUnstartedAdmission:async()=>{repairs++;phase="rejected";reason="admission_unconfirmed";}} as unknown as MemberStore;
  const temporal={connection:{withDeadline:async(_deadline:number,fn:()=>Promise<unknown>)=>fn()},workflow:{getHandle:(id:string,...rest:unknown[])=>{
    assert.match(id,/birbcrew-ts\/member\//);assert.equal(rest.length,0);
    return {describe:async()=>{describes++;return {status:{name:terminal}};}};
  },start:()=>{throw new Error("Must never start work during status");}}} as unknown as Client;
  const client=new MemberClient(store,temporal),key={ownerId:f.request.ownerId,conversationId:f.request.conversationId,requestId:f.request.requestId};
  assert.equal((await client.requestStatus(key)).phase,"accepted");
  terminal="CONTINUED_AS_NEW";assert.equal((await client.requestStatus(key)).phase,"accepted");assert.equal(repairs,0);
  terminal="FAILED";assert.equal((await client.requestStatus(key)).phase,"rejected");assert.equal(repairs,1);
  assert.equal((await client.requestStatus(key)).reason,"admission_unconfirmed");assert.equal(describes,3);
});
