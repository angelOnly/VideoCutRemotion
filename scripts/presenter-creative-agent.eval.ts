import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const requiredSkills = [
  "production-director",
  "presenter-motion-director",
  "semantic-continuity",
  "visual-treatment-planning",
  "effect-timing",
  "remotion-production",
  "quality-verification"
];

const requiredTools = [
  "start_production_run",
  "record_creative_decision",
  "record_editorial_quality_review",
  "complete_production_run",
  "read_skill_execution_report",
  "apply_manual_transcript",
  "apply_semantic_units",
  "assemble_presenter_track",
  "compile_presenter_scenes",
  "render_preview_range",
  "read_quality_report",
  "validate_project_graph",
  "inspect_composed_frames"
];

function textFromToolResult(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) {
    throw new Error("MCP 没有返回标准 content");
  }
  const first = result.content[0];
  if (!first || typeof first !== "object" || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("MCP 没有返回文本结果");
  }
  return first.text;
}

/**
 * 这个验收脚本只经由 video-editor-mcp 操作，不直接 import EditingApplication。
 * 它验证“Skill → MCP → 报告 → 预览/质量工具”已经可被真实 Codex 任务调用。
 * Codex 的专业判断本身不能由一个 Node 脚本伪造，因此脚本不会声称已完成审美验收。
 */
async function main(): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "videocut-creative-eval-"));
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
  const transport = new StdioClientTransport({
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["run", "mcp"],
    cwd: process.cwd(),
    env: { ...environment, VIDEOCUT_WORKSPACE: workspaceRoot },
    stderr: "pipe"
  });
  const client = new Client({ name: "videocut-presenter-creative-eval", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const toolNames = new Set(tools.tools.map((tool) => tool.name));
    for (const name of requiredTools) assert.ok(toolNames.has(name), `缺少创作验收工具：${name}`);

    const created = JSON.parse(textFromToolResult(await client.callTool({ name: "create_project", arguments: { name: "Presenter Creative Agent Eval", profile: "presenter_motion" } }))) as { revision: { number: number }; snapshot: { project: { id: string } } };
    const projectId = created.snapshot.project.id;
    const run = JSON.parse(textFromToolResult(await client.callTool({
      name: "start_production_run",
      arguments: { project_id: projectId, base_revision_id: created.revision.number, loaded_skills: requiredSkills, loaded_references: [".agents/skills/_shared/EDITORIAL_FOUNDATIONS.md"] }
    }))) as { id: string; loadedSkills: string[] };
    assert.deepEqual(run.loadedSkills, requiredSkills);

    const recorded = JSON.parse(textFromToolResult(await client.callTool({
      name: "record_creative_decision",
      arguments: {
        project_id: projectId,
        run_id: run.id,
        category: "quality",
        decision: "将真实预览和质量复核列为交付前必经步骤",
        rationale: "组件冒烟测试不能证明脚本、素材和节奏的实际成片质量",
        mcp_command: "presenter-creative-agent.eval"
      }
    }))) as { creativeDecisions: unknown[] };
    assert.equal(recorded.creativeDecisions.length, 1);

    const report = JSON.parse(textFromToolResult(await client.callTool({ name: "read_skill_execution_report", arguments: { project_id: projectId, run_id: run.id } }))) as { id: string; status: string };
    assert.equal(report.id, run.id);
    assert.equal(report.status, "active");
    const completed = JSON.parse(textFromToolResult(await client.callTool({ name: "complete_production_run", arguments: { project_id: projectId, run_id: run.id } }))) as { status: string; completionBlockers?: string[] };
    assert.equal(completed.status, "incomplete", "没有真实项目、预览和审片证据的 Run 不能被伪装成完成");
    assert.ok(completed.completionBlockers?.length, "不完整 Run 必须返回可补齐的收口条件");

    console.log(JSON.stringify({
      test: "presenter-creative-agent.eval",
      result: "MCP 与 SkillExecutionReport 接入通过，未执行真实创作时会被正确保留为 incomplete",
      requiredSkills,
      requiredTools,
      nextStep: "在真实视频项目中由 Codex 按这些 Skill 生成语义、Scene、Cue，渲染 Preview 后把证据和质量复核写入同一 ProductionRun。"
    }, null, 2));
  } finally {
    await transport.close().catch(() => undefined);
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
