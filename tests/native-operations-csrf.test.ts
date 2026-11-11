import test from "node:test";
import assert from "node:assert/strict";
import { createNativeCsrfCodec,createNativeSelectionCodec } from "../src/lib/server/native-operations-csrf";
const secret="synthetic-fixture-signing-key-for-csrf-only";
test("CSRF binds current member, main session and authoritative permissions",()=>{
 const codec=createNativeCsrfCodec(secret,()=>1800000000000),token=codec.mint("member-A","main-session-A","student:3:checksum-A");
 assert.equal(codec.verify("member-A","main-session-A",token,token,"student:3:checksum-A"),true);
 for(const [owner,session,permission]of [["member-B","main-session-A","student:3:checksum-A"],["member-A","main-session-B","student:3:checksum-A"],["member-A","main-session-A","student:4:checksum-B"]])assert.equal(codec.verify(owner,session,token,token,permission),false);
 assert.ok(!token.includes("main-session-A"));assert.ok(!token.includes("member-A"));
});
test("filter confirmation binds the owner and exact frozen usage/CAS set",()=>{
 const codec=createNativeSelectionCodec(secret,()=>1800000000000),items=[{id:"A",expectedRevision:1,expectedMetadataRevision:2,expectedUsageFingerprint:"a".repeat(64)},{id:"B",expectedRevision:3,expectedMetadataRevision:1,expectedUsageFingerprint:"b".repeat(64)}],signed=codec.mint("owner-A",items);
 assert.equal(codec.verify("owner-A",items,signed),true);assert.equal(codec.verify("owner-B",items,signed),false);
 assert.equal(codec.verify("owner-A",[items[1],items[0]],signed),false);assert.equal(codec.verify("owner-A",[{...items[0],expectedUsageFingerprint:"c".repeat(64)},items[1]],signed),false);
 assert.equal(codec.verify("owner-A",[{expectedMetadataRevision:2,expectedRevision:1,id:"A",expectedUsageFingerprint:"a".repeat(64)},items[1]],signed),true);
});
test("filter preview expires and cannot be reused as a main-session CSRF token",()=>{
 let time=1800000000000;const selection=createNativeSelectionCodec(secret,()=>time),csrf=createNativeCsrfCodec(secret,()=>time),items=[{id:"A",expectedRevision:1}],signed=selection.mint("owner-A",items);
 assert.equal(csrf.verify("owner-A","main-session",signed,signed,"permission"),false);time+=20*60*1000;assert.equal(selection.verify("owner-A",items,signed),false);
});
test("same-owner tabs can reuse the current cookie while expiry and tampering reject",()=>{
 let time=1800000000000;const codec=createNativeCsrfCodec(secret,()=>time),token=codec.mint("member-A","session-A","permission-A");
 const bootstrap=()=>codec.verify("member-A","session-A",token,token,"permission-A")?token:codec.mint("member-A","session-A","permission-A");
 assert.equal(bootstrap(),token);assert.equal(bootstrap(),token);assert.equal(codec.verify("member-A","session-A",token,bootstrap(),"permission-A"),true);
 assert.equal(codec.verify("member-A","session-A",token,`${token}x`,"permission-A"),false);assert.equal(codec.verify("member-A","session-A",`${token.slice(0,-1)}!`,`${token.slice(0,-1)}!`,"permission-A"),false);
 time+=20*60*1000;assert.equal(codec.verify("member-A","session-A",token,token,"permission-A"),false);
});
