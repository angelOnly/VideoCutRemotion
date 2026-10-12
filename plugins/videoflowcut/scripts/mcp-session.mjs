const schemaNotes = new Set(["description", "title", "$comment", "examples"]);
const schemaMaps = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"]);
const schemaChildren = new Set(["items", "additionalItems", "additionalProperties", "unevaluatedItems", "unevaluatedProperties", "contains", "propertyNames", "not", "if", "then", "else", "allOf", "anyOf", "oneOf", "prefixItems", "contentSchema"]);

/** 只排除 Schema 的说明，不能误删名为 title/description 的输入字段或默认值。 */
function schemaContract(schema) {
  if (Array.isArray(schema)) return schema.map(schemaContract);
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(Object.entries(schema).filter(([key]) => !schemaNotes.has(key)).map(([key, value]) => {
    if (schemaMaps.has(key) && value && typeof value === "object" && !Array.isArray(value)) return [key, Object.fromEntries(Object.entries(value).map(([name, child]) => [name, schemaContract(child)]))];
    return [key, schemaChildren.has(key) ? schemaContract(value) : value];
  }));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function toolContract(tool) {
  const { description, title, icons, ...contract } = tool;
  if (contract.inputSchema) contract.inputSchema = schemaContract(contract.inputSchema);
  if (contract.outputSchema) contract.outputSchema = schemaContract(contract.outputSchema);
  if (contract.annotations) {
    const { title: annotationTitle, ...behavior } = contract.annotations;
    if (Object.keys(behavior).length) contract.annotations = behavior;
    else delete contract.annotations;
  }
  return JSON.stringify(canonical(contract));
}

/** 保持宿主连接，仅在已完成调用之间切换业务 MCP；任何未知结果都不自动重放。 */
export function createReloadingMcpSession({ initialTools, resolveDeployment, connect, onToolsChanged = async () => {}, runExclusive = (action) => action() }) {
  if (!Array.isArray(initialTools) || initialTools.length === 0
    || initialTools.some((tool) => !tool?.name || tool.inputSchema?.type !== "object")
    || new Set(initialTools.map((tool) => tool.name)).size !== initialTools.length) {
    throw new Error("MCP 发行工具目录缺失或无效，请重新构建并安装插件");
  }
  let current;
  let targetProjectId;
  let exposed = new Map();
  let queue = Promise.resolve();
  let closed = false;
  const fingerprint = toolContract;
  const serial = (action, lockOptions) => {
    const result = queue.then(() => {
      if (closed) throw new Error("MCP 连接管理层已关闭");
      return runExclusive(action, lockOptions);
    });
    queue = result.catch(() => {});
    return result;
  };
  const refresh = async () => {
    const deployment = await resolveDeployment();
    if (current?.releaseId === deployment.releaseId && current.runtimeId === deployment.runtimeId && current.isAlive()) return;
    // 先握手并核对新进程，再替换旧连接；失败时绝不把旧进程冒充新版。
    const next = await connect(deployment);
    try {
      if (targetProjectId) {
        const restored = await next.callTool({ name: "target_project", arguments: { project_id: targetProjectId } });
        if (restored.isError) throw new Error("新版 MCP 无法恢复原项目定位；请明确重新选择项目");
      }
      const previous = current;
      current = next;
      try { await previous?.close(); }
      finally {
        if (exposed.size && JSON.stringify(previous?.tools ?? initialTools) !== JSON.stringify(next.tools)) await onToolsChanged();
      }
    } catch (error) {
      if (current !== next) await next.close();
      throw error;
    }
  };
  return {
    // 后台探活争锁失败可留到下次；不能占着本会话队列等待一次完整业务时限。
    refresh: () => serial(refresh, { waitTimeoutMs: 1000, operationName: "MCP后台探活" }),
    listTools: async () => {
      if (closed) throw new Error("MCP 连接管理层已关闭");
      // Codex 可能缓存首次目录且不响应变更通知；发现能力不能等待 Runtime 或部署锁。
      // 初始目录由同一发行 MCP 实际导出并纳入 Release ID，调用仍经过实时健康与 Schema 门禁。
      const tools = current?.tools ?? initialTools;
      exposed = new Map(tools.map((tool) => [tool.name, fingerprint(tool)]));
      return { tools };
    },
    callTool: (params, options) => serial(async () => {
      try { await refresh(); } catch (error) {
        return { isError: true, content: [{ type: "text", text: `MCP_RUNTIME_UNAVAILABLE：${error instanceof Error ? error.message : error}。本次未执行；连接保留，恢复后请重新读回状态。` }] };
      }
      // 排队期间宿主已取消的请求不能等到部署完成后再落地。
      if (options?.signal?.aborted) return { isError: true, content: [{ type: "text", text: "MCP_CALL_CANCELLED：请求已取消，本次未执行。" }] };
      const tool = current.tools.find((item) => item.name === params.name);
      if (!tool || exposed.get(params.name) !== fingerprint(tool)) {
        return { isError: true, content: [{ type: "text", text: "MCP_TOOL_SCHEMA_CHANGED：工具定义已更新；请刷新工具表并重新判断参数。本次未执行。" }] };
      }
      try {
        const result = await current.callTool(params, options);
        if (params.name === "target_project" && !result.isError) targetProjectId = params.arguments?.project_id;
        if (params.name === "create_project" && !result.isError) {
          // 创建项目也会改变业务进程的默认定位；仅保存返回的真实 ID，不重放创建。
          targetProjectId = undefined;
          const text = result.content?.find((item) => item.type === "text")?.text;
          try { targetProjectId = JSON.parse(text).snapshot?.project?.id; } catch { /* 无法解析时要求显式定位。 */ }
        }
        return result;
      } catch (error) {
        // 断连可能发生在写入之后；只返回未知结果，不重试当前操作。
        return { isError: true, content: [{ type: "text", text: `MCP_CALL_OUTCOME_UNKNOWN：${error instanceof Error ? error.message : error}。未自动重放；请先读取 Job、Revision 和对象核对副作用。` }] };
      }
    }, { signal: options?.signal, operationName: `MCP工具:${params.name}` }).catch((error) => {
      // 抢锁失败发生在业务派发前，与已派发后的未知结果分开记录。
      if (error?.code === "RUNTIME_LOCK_CANCELLED") return { isError: true, content: [{ type: "text", text: "MCP_CALL_CANCELLED：等待操作锁时请求已取消，本次未执行。" }] };
      if (error?.code === "RUNTIME_LOCK_TIMEOUT") return { isError: true, content: [{ type: "text", text: `MCP_RUNTIME_BUSY：${error.message}。未自动重放；连接保留。` }] };
      if (error?.code === "RUNTIME_LOCK_RELEASE_FAILED") return { isError: true, content: [{ type: "text", text: `MCP_CALL_OUTCOME_UNKNOWN：${error.message}。未自动重放；连接保留。` }] };
      throw error;
    }),
    close: async () => {
      closed = true;
      await queue;
      await current?.close();
    }
  };
}
