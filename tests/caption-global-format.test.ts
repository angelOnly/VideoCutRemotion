import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "../apps/server/src/app.js";
import { DEFAULT_CAPTION_FORMAT } from "@videocut/contracts";
import { resolveCaptionFormat } from "../packages/contracts/src/caption-presentation.js";

test("全片样式经 HTTP/MCP 原子保存，新卡继承，局部改样式拒绝且历史不被改写", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-global-caption-"));
  const { app, application } = await createServer({ workspaceRoot: root });
  const client = new Client({ name: "全片字幕合同回归", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "apps/server/src/mcp.ts"], cwd: process.cwd(),
    env: { ...process.env as Record<string, string>, VIDEOCUT_WORKSPACE: root }, stderr: "pipe" });
  try {
    const initial = application.createProject({ name: "全片字幕隔离验证" });
    const projectId = initial.snapshot.project.id;
    assert.equal(initial.snapshot.timeline.captionFormat?.fontId, "noto-sans-sc-bold");
    assert.equal(initial.snapshot.timeline.captionFormat?.font?.hash.length, 64);
    const patched = await app.inject({ method: "PATCH", url: `/api/projects/${projectId}/captions/global-format`, payload: {
      baseRevision: initial.revision.number,
      format: { fontId: "noto-serif-sc-semibold", fontSize: 40, maxLines: 1, lineHeight: 1.5, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 6, boxWidth: "full", backgroundColor: "#112233", textShadow: null }
    } });
    assert.equal(patched.statusCode, 200, patched.body);
    const after = application.readProject(projectId);
    const format = after.snapshot.timeline.captionFormat!;
    assert.equal(format.font?.fontId, "noto-serif-sc-semibold");
    assert.equal(format.font?.family, `VFC_${format.font?.hash}`);
    assert.equal(format.fontSize, 40);
    assert.equal(format.maxLines, 1);
    assert.equal(format.boxWidth, "full");

    // 模拟生成路径提交新卡，旧默认样式不能覆盖已经采用的全片规范。
    const authored = application.applyAuthoredScript({ projectId, baseRevision: after.revision.number, sourceNote: "隔离合同夹具，不代表真实配音", units: [{ text: "准确文字", kind: "statement" }] });
    const generated = application.repository.commit(projectId, authored.revision.number, "隔离夹具生成字幕", snapshot => {
      snapshot.timeline.durationInFrames = 48;
      snapshot.timeline.captions.push({ id: "new-card", speechSegmentId: snapshot.speechSegments[0]!.id, text: "准确文字", sourceText: "准确文字", startFrame: 0, endFrame: 24,
        style: "stable", sourceKind: "speech_asset", textMode: "derived", precision: "segment_exact", format: { ...DEFAULT_CAPTION_FORMAT, color: "#ff0000" }, emphasis: { text: "准确", occurrence: 0, scale: 1.3 } });
    });
    const card = generated.snapshot.timeline.captions[0]!;
    assert.equal(card.format, undefined);
    assert.equal(card.emphasis, undefined);
    assert.deepEqual(resolveCaptionFormat(generated.snapshot.timeline, card), format);
    assert.throws(() => application.editCaptions({ projectId, baseRevision: generated.revision.number, captionId: card.id, action: "update", format: { color: "#ff0000" } }), { code: "CAPTION_GLOBAL_FORMAT_REQUIRED" });
    assert.equal(application.readProject(projectId).revision.number, generated.revision.number);

    await client.connect(transport);
    const args = { project_id: projectId, base_revision_id: generated.revision.number, action: "set_global_format" };
    for (const format of [{ max_lines: 3 }, { line_height: 0 }, { padding_horizontal: -1 }, { font_id: "not-a-registered-font" }, { font: { family: "arbitrary" } }, {}]) {
      const result = await client.callTool({ name: "edit_captions", arguments: { ...args, format } });
      assert.equal(result.isError, true, JSON.stringify(result));
      assert.equal(application.readProject(projectId).revision.number, generated.revision.number);
    }
    const accepted = await client.callTool({ name: "edit_captions", arguments: { ...args, format: { color: "#abcdef", max_lines: 2, text_shadow: null } } });
    assert.notEqual(accepted.isError, true, JSON.stringify(accepted));
    const final = application.readProject(projectId);
    const read = await client.callTool({ name: "read_captions", arguments: { project_id: projectId } });
    const readBack = JSON.parse((read.content as Array<{ text: string }>)[0]!.text);
    assert.equal(readBack.presentation, "global");
    assert.deepEqual(readBack.captionFormat, final.snapshot.timeline.captionFormat);
    assert.deepEqual(readBack.captions, final.snapshot.timeline.captions);
    assert.equal(final.snapshot.timeline.captionFormat?.color, "#abcdef");
    assert.equal(final.snapshot.timeline.captionFormat?.maxLines, 2);
    assert.equal(final.snapshot.timeline.captionFormat?.font?.hash, format.font?.hash, "改颜色不重新选择字体文件");
    assert.deepEqual(final.snapshot.timeline.captions, generated.snapshot.timeline.captions);
    assert.deepEqual(final.snapshot.script, generated.snapshot.script);
    assert.deepEqual(final.snapshot.timeline.items, generated.snapshot.timeline.items);
    const conflict = await app.inject({ method: "PATCH", url: `/api/projects/${projectId}/captions/global-format`, payload: { baseRevision: initial.revision.number, format: { color: "#ffffff" } } });
    assert.equal(conflict.statusCode, 409);

    const legacy = application.repository.commit(projectId, final.revision.number, "隔离历史夹具", snapshot => {
      delete snapshot.timeline.captionFormat;
      snapshot.timeline.captions[0]!.format = { ...DEFAULT_CAPTION_FORMAT, color: "#fedcba" };
    });
    const migrated = application.editCaptions({ projectId, baseRevision: legacy.revision.number, action: "set_global_format", format: { color: "#123456" } });
    assert.equal(migrated.snapshot.timeline.captions[0]!.format, undefined);
    assert.equal(migrated.snapshot.timeline.captionFormat?.fontId, "noto-sans-sc-bold");
    assert.equal(legacy.snapshot.timeline.captions[0]!.format?.color, "#fedcba");
    assert.equal(initial.snapshot.timeline.captionFormat?.fontSize, 32);
  } finally { await client.close(); await transport.close(); await app.close(); application.close(); await rm(root, { recursive: true, force: true }); }
});
