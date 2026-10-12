import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import test from "node:test";

const { createReloadingMcpSession } = await import(pathToFileURL(resolve("plugins/videoflowcut/scripts/mcp-session.mjs")).href);
const catalog = ["target_project", "read_project", "write"].map((name) => ({ name, inputSchema: { type: "object" } }));
function fixture(initialTools = catalog, runExclusive = (action: () => Promise<unknown>, _options?: any) => action()) {
  let releaseId = "A";
  let tools = initialTools;
  let healthy = true;
  let changed = 0;
  let write: undefined | (() => Promise<unknown>);
  const calls: Array<{ release: string; name: string; target?: string }> = [];
  const closed: string[] = [];
  const session = createReloadingMcpSession({
    initialTools,
    runExclusive,
    resolveDeployment: async () => {
      if (!healthy) throw new Error("not ready");
      return { releaseId };
    },
    connect: async (deployment: { releaseId: string }) => {
      let target: string | undefined;
      return {
        releaseId: deployment.releaseId, tools, isAlive: () => true,
        close: async () => { closed.push(deployment.releaseId); },
        callTool: async (params: { name: string; arguments?: { project_id?: string } }) => {
          if (params.name === "target_project") target = params.arguments?.project_id;
          calls.push({ release: deployment.releaseId, name: params.name, target });
          if (params.name === "write" && write) return write();
          return { content: [{ type: "text", text: JSON.stringify({ release: deployment.releaseId, target }) }] };
        }
      };
    },
    onToolsChanged: async () => { changed++; }
  });
  return { session, calls, closed, changed: () => changed,
    publish: (value: string, newTools = catalog) => { releaseId = value; tools = newTools; },
    health: (value: boolean) => { healthy = value; },
    setWrite: (value: () => Promise<unknown>) => { write = value; }
  };
}

test("MCP 保持同一连接切换版本，并在新版恢复原项目定位", async () => {
  const f = fixture();
  await f.session.listTools();
  await f.session.callTool({ name: "target_project", arguments: { project_id: "project-test" } });
  f.publish("B");
  const result = await f.session.callTool({ name: "read_project" });
  assert.deepEqual(JSON.parse(result.content[0].text), { release: "B", target: "project-test" });
  assert.deepEqual(f.closed, ["A"]);
  assert.equal(f.changed(), 0);
  await f.session.close();
});

test("发布必须等待在途调用完成，未知写入结果不自动重放", async () => {
  const f = fixture();
  await f.session.listTools();
  let started!: () => void;
  let finish!: () => void;
  const began = new Promise<void>((done) => { started = done; });
  f.setWrite(() => new Promise((_done, reject) => { started(); finish = () => reject(new Error("lost response")); }));
  const pending = f.session.callTool({ name: "write" });
  await began;
  f.publish("B");
  const next = f.session.callTool({ name: "read_project" });
  assert.deepEqual(f.closed, []);
  finish();
  assert.match((await pending).content[0].text, /MCP_CALL_OUTCOME_UNKNOWN/);
  assert.equal(JSON.parse((await next).content[0].text).release, "B");
  assert.equal(f.calls.filter((call) => call.name === "write").length, 1);
  await f.session.close();
});

test("Schema 变化会通知刷新，旧参数不执行，刷新工具表后才能使用", async () => {
  const f = fixture();
  await f.session.listTools();
  f.publish("B", catalog.map((tool) => ({ ...tool, inputSchema: { type: "object", properties: { revision: { type: "integer" } }, required: ["revision"] } })));
  const rejected = await f.session.callTool({ name: "write" });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /MCP_TOOL_SCHEMA_CHANGED/);
  assert.equal(f.changed(), 1);
  assert.equal(f.calls.length, 0);
  await f.session.listTools();
  assert.notEqual((await f.session.callTool({ name: "write" })).isError, true);
  await f.session.close();
});

test("工具说明和字段说明更新不阻断相同合同，仍发送目录变更通知", async () => {
  const initial = catalog.map((tool) => ({ ...tool, description: "旧说明", inputSchema: { type: "object", properties: { title: { type: "string", description: "输入字段的旧说明" }, description: { type: "string" } } } }));
  const f = fixture(initial);
  await f.session.listTools();
  f.publish("B", initial.map((tool) => ({ ...tool, description: "新说明", title: "新展示标题", annotations: { title: "界面标题" }, inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, title: { type: "string", description: "输入字段的新说明", examples: ["示例"] } } } })));
  assert.notEqual((await f.session.callTool({ name: "write" })).isError, true);
  assert.equal(f.changed(), 1);
  assert.equal(f.calls.filter((call) => call.name === "write").length, 1);
  assert.equal((await f.session.listTools()).tools[0].description, "新说明");
  await f.session.close();
});

test("命名为说明的字段、默认值和行为提示仍属于受保护合同", async () => {
  const initial = catalog.map((tool) => ({ ...tool, inputSchema: { type: "object", properties: { description: { type: "string" }, title: { type: "string", default: "A" } } }, annotations: { readOnlyHint: true }, outputSchema: { type: "object", properties: { ok: { type: "boolean" } } } }));
  const variants = [
    initial.map((tool) => ({ ...tool, inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, description: { type: "number" } } } })),
    initial.map((tool) => ({ ...tool, inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, title: { type: "string", default: "B" } } } })),
    initial.map((tool) => ({ ...tool, annotations: { readOnlyHint: false } })),
    initial.map((tool) => ({ ...tool, outputSchema: { type: "object", properties: { ok: { type: "string" } } } }))
  ];
  for (const changedTools of variants) {
    const f = fixture(initial);
    await f.session.listTools();
    f.publish("B", changedTools);
    assert.match((await f.session.callTool({ name: "write" })).content[0].text, /MCP_TOOL_SCHEMA_CHANGED/);
    assert.equal(f.calls.length, 0);
    await f.session.close();
  }
});

test("新 Runtime 不健康时不回退到旧 MCP 执行写入", async () => {
  const f = fixture();
  await f.session.listTools();
  f.publish("B");
  f.health(false);
  assert.match((await f.session.callTool({ name: "write" })).content[0].text, /MCP_RUNTIME_UNAVAILABLE/);
  assert.equal(f.calls.length, 0);
  f.health(true);
  assert.equal(JSON.parse((await f.session.callTool({ name: "read_project" })).content[0].text).release, "B");
  await f.session.close();
});

test("首次 Runtime 故障仍提供完整发行工具，恢复无需宿主重新拉表", async () => {
  const f = fixture();
  f.health(false);
  assert.deepEqual(await f.session.listTools(), { tools: catalog });
  assert.match((await f.session.callTool({ name: "write" })).content[0].text, /MCP_RUNTIME_UNAVAILABLE/);
  assert.equal(f.calls.length, 0);
  f.health(true);
  await f.session.refresh();
  assert.equal(f.changed(), 0);
  // 模拟 Codex 不重新请求 tools/list：同一已发现工具仍须恢复执行。
  assert.notEqual((await f.session.callTool({ name: "read_project" })).isError, true);
  await f.session.close();
});

test("工具发现不等待 Runtime 或部署锁，关闭后不得继续提供目录", async () => {
  let locked = 0;
  const session = createReloadingMcpSession({
    initialTools: catalog,
    resolveDeployment: () => { throw new Error("Runtime 离线"); },
    connect: () => { throw new Error("不应连接"); },
    runExclusive: () => { locked++; throw new Error("锁被占用"); }
  });
  assert.deepEqual(await session.listTools(), { tools: catalog });
  assert.equal(locked, 0);
  await session.close();
  await assert.rejects(() => session.listTools(), /已关闭/);
});

test("拒绝没有实际发行目录的 MCP 启动，不能把空表当成成功", () => {
  assert.throws(() => createReloadingMcpSession({
    initialTools: [], resolveDeployment: async () => ({}), connect: async () => ({})
  }), /发行工具目录/);
});

test("排队期间已取消的调用不能在发布后继续写入", async () => {
  const f = fixture();
  await f.session.listTools();
  const controller = new AbortController();
  controller.abort();
  const result = await f.session.callTool({ name: "write" }, { signal: controller.signal });
  assert.match(result.content[0].text, /MCP_CALL_CANCELLED/);
  assert.equal(f.calls.length, 0);
  await f.session.close();
});

test("抢锁超时明确未执行，取消信号传至操作锁，连接恢复后仍可正常调用", async () => {
  const controller = new AbortController();
  let errorCode: string | undefined = "RUNTIME_LOCK_TIMEOUT";
  const received: any[] = [];
  const f = fixture(catalog, async (action, options) => {
    received.push(options);
    if (errorCode) throw Object.assign(new Error("等待操作锁超时，本次未执行"), { code: errorCode });
    return action();
  });
  await f.session.listTools();
  assert.match((await f.session.callTool({ name: "write" })).content[0].text, /MCP_RUNTIME_BUSY.*本次未执行/);
  errorCode = "RUNTIME_LOCK_CANCELLED";
  assert.match((await f.session.callTool({ name: "write" }, { signal: controller.signal })).content[0].text, /MCP_CALL_CANCELLED.*本次未执行/);
  assert.equal(received[1].signal, controller.signal);
  assert.equal(received[1].operationName, "MCP工具:write");
  assert.equal(f.calls.length, 0);
  errorCode = "RUNTIME_LOCK_RELEASE_FAILED";
  assert.match((await f.session.callTool({ name: "write" })).content[0].text, /MCP_CALL_OUTCOME_UNKNOWN/);
  errorCode = undefined;
  assert.notEqual((await f.session.callTool({ name: "read_project" })).isError, true);
  assert.equal(f.calls.length, 1);
  await f.session.close();
});

test("后台探活只短暂等待争锁，失败不堵住后续工具队列", async () => {
  const f = fixture(catalog, async (action, options) => {
    if (options?.operationName === "MCP后台探活") {
      assert.equal(options.waitTimeoutMs, 1000);
      throw Object.assign(new Error("忙"), { code: "RUNTIME_LOCK_TIMEOUT" });
    }
    return action();
  });
  await f.session.listTools();
  await assert.rejects(f.session.refresh(), { code: "RUNTIME_LOCK_TIMEOUT" });
  assert.notEqual((await f.session.callTool({ name: "read_project" })).isError, true);
  assert.equal(f.calls.length, 1);
  await f.session.close();
});
