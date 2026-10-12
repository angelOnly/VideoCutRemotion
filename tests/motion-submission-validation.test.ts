import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApplication } from "@videocut/application";
import { createServer } from "../apps/server/src/app.js";
import { registerMotionTools } from "../apps/server/src/motion-tools.js";
import { toolError } from "../apps/server/src/tool-error.js";
import { validateMotionSource, compileMotion } from "../packages/motion-work/src/compiler.js";
import { MotionSourceValidationError } from "../packages/motion-work/src/source-validation-error.js";
import { motionFixture } from "./fixtures/managed-motion.js";
import { readFile } from "node:fs/promises";

const good = `import React from 'react';
function RuleLine({top}:{top:number}){return <div style={{position:'absolute',top,left:0,width:320,height:100,background:'#00ff00'}}/>;}
export default function Motion(){return <RuleLine top={148}/>;}`;
const bad = good.replace("top={148}", "top={window.top}");
const body = (source: string, revision: number, key: string) => ({ baseRevision: revision, idempotencyKey: key, work: { ...motionFixture, source } });
const parsed = (result: any) => JSON.parse(result.content.find((entry: any) => entry.type === "text").text);

test("源码纠正合同在Skills保留原作者交接和已入队失败边界", async () => {
  for (const path of [".agents/skills/known-errors/references/submission-errors.md"]) {
    const text = await readFile(path, "utf8");
    for (const keyword of ["work.source", "correct_input", "原作者", "Worker", "纠正", "平台误判"]) assert.ok(text.includes(keyword), `${path} 缺少 ${keyword}`);
  }
  const contract = await readFile(".agents/skills/remotion-production/references/submission-and-recovery.md", "utf8");
  assert.ok(contract.includes("<RuleLine top={148}/>"));
  assert.ok(contract.includes("top={window.top}"));
});

test("JSX属性只豁免名称，属性值、展开、简写与DOM限制继续检查", () => {
  for (const source of [good, good.replace("top={148}", 'top={"148"}'), good.replace("top={148}", "top={100+48}"),
    good.replace("<RuleLine top={148}/>", "RuleLine({top:148})")]) assert.doesNotThrow(() => validateMotionSource(source));
  for (const source of [bad, good.replace("top={148}", "top={top}"), good.replace("top={148}", "{...window}"),
    good.replace("top={148}", "{...{top}}"), good.replace("top={148}", "top={fetch('https://example.com')}"),
    good.replace("top={148}", "top={148} onClick={()=>1}"), good.replace("top={148}", "top={148} dangerouslySetInnerHTML={{__html:'x'}}")]) {
    assert.throws(() => validateMotionSource(source), MotionSourceValidationError);
  }
  try { validateMotionSource(bad); assert.fail("应拒绝全局访问"); } catch (error) {
    assert.ok(error instanceof MotionSourceValidationError);
    assert.equal(error.code, "MOTION_API_REJECTED");
    assert.equal(error.token, "window");
    assert.deepEqual(error.location, { line: 3, column: bad.split("\n")[2].indexOf("window") + 1 });
    assert.equal(toolError(error).sideEffects, "unknown", "底层校验错误不能自行宣称尚未入队");
    assert.equal(toolError(error).safeToRetry, false);
  }
});

test("已知源码拒绝全部提供结构化诊断，编译入口不携带提交重试许可", async () => {
  for (const source of ["export default function (", "import x from 'unknown';export default ()=>null;", "const x=1;",
    "export default ()=> <iframe/>;", "export default ()=> <div style={{animation:'x'}}/>;",
    "export default ()=> <div>{Math.random()}</div>;", "export {x} from 'react';"]) {
    assert.throws(() => validateMotionSource(source), error => error instanceof MotionSourceValidationError && error.location.line > 0 && error.suggestion.length > 0);
  }
  await assert.rejects(compileMotion({ ...motionFixture, source: bad }), error => {
    assert.ok(error instanceof MotionSourceValidationError);
    assert.equal(toolError(error).safeToRetry, false);
    return true;
  });
});

test("真实MCP源码拒绝无写入，纠正后同键入队且保留幂等保护", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-source-mcp-"));
  const application = createApplication(root);
  const server = new McpServer({ name: "源码诊断验证", version: "1" });
  const client = new Client({ name: "源码诊断客户端", version: "1" });
  try {
    const created = application.createProject({ name: "隔离源码测试" });
    const projectId = created.snapshot.project.id;
    const before = application.readProject(projectId);
    registerMotionTools(server, application, () => projectId);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st); await client.connect(ct);
    const submit = (source: string, key = "source-correction") => client.callTool({ name: "submit_motion_work", arguments: {
      project_id: projectId, base_revision_id: before.revision.number, idempotency_key: key, work: { ...motionFixture, source }
    } });
    const rejected = await submit(bad);
    assert.equal(rejected.isError, true);
    const diagnostic = parsed(rejected);
    assert.equal(diagnostic.code, "MOTION_API_REJECTED");
    assert.equal(diagnostic.stage, "validation"); assert.equal(diagnostic.sideEffects, "none");
    assert.equal(diagnostic.safeToRetry, true); assert.equal(diagnostic.recovery, "correct_input");
    assert.equal(diagnostic.fields[0].field, "work.source"); assert.equal(diagnostic.fields[0].token, "window");
    assert.ok(diagnostic.fields[0].suggestion);
    assert.deepEqual(application.readProject(projectId), before);
    assert.equal(application.repository.listJobs(projectId).length, 0);
    const accepted = await submit(good);
    assert.notEqual(accepted.isError, true);
    assert.equal(parsed(await submit(good)).id, parsed(accepted).id);
    assert.equal(application.repository.listJobs(projectId).length, 1);
    assert.equal(parsed(await submit(good.replace("148", "149"))).code, "MOTION_IDEMPOTENCY_CONFLICT");
    assert.deepEqual(application.readProject(projectId), before);
    // 模拟入队后调用链丢失结果，不能因异常文字类似源码拒绝就给重试许可。
    const original = application.submitManagedMotion.bind(application);
    application.submitManagedMotion = input => { original(input); throw new Error("MOTION_API_REJECTED: 模拟入队后故障"); };
    const unknown = parsed(await submit(good, "after-enqueue"));
    assert.equal(unknown.sideEffects, "unknown"); assert.equal(unknown.safeToRetry, false);
    assert.equal(application.repository.listJobs(projectId).length, 2);
  } finally { await client.close(); await server.close(); application.close(); await rm(root, { recursive: true, force: true }); }
});

test("HTTP提交前源码拒绝返回400，意外异常返回500", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-source-http-"));
  const { app, application } = await createServer({ workspaceRoot: root });
  try {
    const created = application.createProject({ name: "隔离HTTP测试" });
    const projectId = created.snapshot.project.id;
    const before = application.readProject(projectId);
    const response = await app.inject({ method: "POST", url: `/api/projects/${projectId}/motion-works`, payload: body(bad, before.revision.number, "http-source") });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, "MOTION_API_REJECTED"); assert.equal(response.json().sideEffects, "none");
    assert.deepEqual(application.readProject(projectId), before);
    assert.equal(application.repository.listJobs(projectId).length, 0);
    application.submitManagedMotion = () => { throw new Error("模拟平台异常"); };
    const failure = await app.inject({ method: "POST", url: `/api/projects/${projectId}/motion-works`, payload: body(good, before.revision.number, "http-crash") });
    assert.equal(failure.statusCode, 500); assert.equal(failure.json().safeToRetry, undefined);
  } finally { await app.close(); application.close(); await rm(root, { recursive: true, force: true }); }
});
