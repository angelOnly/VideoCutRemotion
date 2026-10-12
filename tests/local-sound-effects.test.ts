import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runProcess } from "@videocut/speech";

function textFromToolResult(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) assert.fail("MCP 应返回标准 content 结果");
  const first = result.content[0];
  if (!first || typeof first !== "object" || first.type !== "text" || typeof first.text !== "string") assert.fail("MCP 应返回文本内容");
  return first.text;
}

async function createSoundEffectFixture(root: string): Promise<string> {
  const nested = join(root, "ui", "hits");
  await mkdir(nested, { recursive: true });
  const path = join(nested, "soft-hit.wav");
  await runProcess("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=0.08",
    "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=0.20",
    "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1[a]",
    "-map", "[a]", "-c:a", "pcm_s16le", path
  ]);
  return path;
}

test("MCP 只能浏览、检测并导入配置根目录内的本地音效", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "videocut-sfx-workspace-"));
  const soundRoot = await mkdtemp(join(tmpdir(), "videocut-sfx-library-"));
  const sourceFile = await createSoundEffectFixture(soundRoot);
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
  const transport = new StdioClientTransport({
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["run", "mcp"],
    cwd: process.cwd(),
    env: {
      ...inheritedEnvironment,
      VIDEOCUT_WORKSPACE: workspaceRoot,
      VIDEOFLOWCUT_SFX_ROOTS: soundRoot
    },
    stderr: "pipe"
  });
  const client = new Client({ name: "videocut-local-sfx-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const sourceInput = tools.tools.find(tool => tool.name === "acquire_source_material")!.inputSchema.properties!.input as { anyOf: Array<{ properties: Record<string, unknown>; description?: string }> };
    assert.equal(sourceInput.anyOf.length, 3);
    assert.ok(!sourceInput.anyOf[0].properties.pageWidth);
    assert.match(sourceInput.anyOf[0].description!, /1440/);
    assert.ok(sourceInput.anyOf[2].properties.pageWidth);
    const duration = tools.tools.find(tool => tool.name === "manage_asset_requirements")!.inputSchema.properties!.min_duration_ms;
    assert.match(JSON.stringify(duration), /null/);
    assert.match(JSON.stringify(duration), /图片不应用/);
    assert.ok(tools.tools.some((tool) => tool.name === "browse_local_sound_effects"));
    assert.ok(tools.tools.some((tool) => tool.name === "inspect_local_sound_effect"));
    assert.ok(tools.tools.some((tool) => tool.name === "import_local_sound_effect"));
    assert.equal(tools.tools.find((tool) => tool.name === "browse_sound_sources")?.annotations?.readOnlyHint, true);
    const sources = JSON.parse(textFromToolResult(await client.callTool({ name: "browse_sound_sources", arguments: {} })));
    assert.deepEqual(sources.sources.map((source: { id: string }) => source.id), ["mixkit", "mixkit_music"]);
    assert.equal(sources.sources[0].original, true);
    assert.ok(sources.sources[0].categories.includes("interface"));
    const manageSchema = tools.tools.find((tool) => tool.name === "manage_audio")!.inputSchema;
    assert.ok(manageSchema.properties?.effect_event);

    const browsed = JSON.parse(textFromToolResult(await client.callTool({
      name: "browse_local_sound_effects",
      arguments: { query: "soft", max_results: 10 }
    }))) as { effects: Array<{ rootId: string; relativePath: string; durationMs: number; }> };
    assert.equal(browsed.effects.length, 1);
    const effect = browsed.effects[0]!;
    assert.equal(effect.relativePath, "ui/hits/soft-hit.wav");
    assert.ok(effect.durationMs > 0);

    const inspected = JSON.parse(textFromToolResult(await client.callTool({
      name: "inspect_local_sound_effect",
      arguments: { root_id: effect.rootId, relative_path: effect.relativePath }
    }))) as { onset: { method: string; detectedNonSilentOnsetMs?: number } };
    assert.equal(inspected.onset.method, "silencedetect");
    assert.ok(inspected.onset.detectedNonSilentOnsetMs !== undefined && inspected.onset.detectedNonSilentOnsetMs >= 40);

    const unsafe = await client.callTool({
      name: "inspect_local_sound_effect",
      arguments: { root_id: effect.rootId, relative_path: "../outside.wav" }
    });
    assert.equal(unsafe.isError, true);
    assert.match(textFromToolResult(unsafe), /相对路径|根目录/u);

    const project = JSON.parse(textFromToolResult(await client.callTool({
      name: "create_project",
      arguments: { name: "本地音效导入测试" }
    }))) as { revision: { number: number }; snapshot: { project: { id: string } } };
    const imported = JSON.parse(textFromToolResult(await client.callTool({
      name: "import_local_sound_effect",
      arguments: {
        project_id: project.snapshot.project.id,
        base_revision_id: project.revision.number,
        root_id: effect.rootId,
        relative_path: effect.relativePath
      }
    }))) as { asset: { kind: string; provenance?: { } }; importedSoundEffect: { relativePath: string } };
    assert.equal(imported.asset.kind, "audio");
    assert.equal(imported.importedSoundEffect.relativePath, effect.relativePath);
    assert.ok(sourceFile.endsWith("soft-hit.wav"));
    const current = JSON.parse(textFromToolResult(await client.callTool({ name: "read_project", arguments: { project_id: project.snapshot.project.id } })));
    const requirement = JSON.parse(textFromToolResult(await client.callTool({ name: "manage_asset_requirements", arguments: {
      project_id: project.snapshot.project.id, base_revision_id: current.revision.number, action: "create",
      title: "公开音效候选", purpose: "测试工具与真实合同", media_kind: "audio", audio_brief: "无语音的短提示", role: "sfx", fallback_plan: "local_audio"
    } })));
    assert.equal(requirement.snapshot.assetRequests[0].mediaKind, "audio");
    assert.equal(requirement.snapshot.assetRequests[0].targetAspectRatio, undefined);
  } finally {
    await transport.close().catch(() => undefined);
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(soundRoot, { recursive: true, force: true });
  }
});
