import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApplication, type EditingApplication } from "@videocut/application";
import { runProcess } from "@videocut/speech";
import { createMediaJobProcessor, runOneJob } from "../apps/job-worker/src/index.js";
import { createServer } from "../apps/server/src/app.js";

type RevisionState = {
  revision: { number: number };
  snapshot: {
    project: { id: string };
    story: { beats: Array<{ id: string; title: string }> };
    narrativeMap?: { beats: Array<{ id: string }> };
    evidenceCaptures: Array<{ id: string }>;
    explainerPrograms: Array<{ id: string; kind: string; status: string; disabled?: boolean }>;
  };
};

type ImportedAsset = {
  state: RevisionState;
  asset: { id: string; status: string };
};

/** 最小图片和 PDF 只用于验证受管导入与真实来源合同，不伪装为可交付素材。 */
async function createEvidenceFixtures(directory: string): Promise<{ imagePath: string; documentPath: string }> {
  const imagePath = join(directory, "evidence-page.png");
  const documentPath = join(directory, "evidence-source.pdf");
  // 通过 FFmpeg 生成，确保 Worker 的 ffprobe 能读到真实图片流，而不是依赖手写二进制常量。
  await runProcess("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=0x315f9d:s=32x32", "-frames:v", "1", imagePath]);
  await writeFile(documentPath, "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n", "utf8");
  return { imagePath, documentPath };
}

function continuousStates() {
  return [
    { phase: "entry" as const, startFrame: 0, endFrame: 6, label: "建立观看问题" },
    { phase: "progressive" as const, startFrame: 6, endFrame: 14, label: "逐步建立关系" },
    { phase: "settled" as const, startFrame: 14, endFrame: 20, label: "保留阅读时间" },
    { phase: "exit" as const, startFrame: 20, endFrame: 24, label: "释放给下一段" }
  ];
}

function continuousMcpStates() {
  return continuousStates().map((state) => ({
    phase: state.phase,
    start_frame: state.startFrame,
    end_frame: state.endFrame,
    label: state.label
  }));
}

async function finishQueuedMediaAnalysis(application: EditingApplication): Promise<void> {
  const processor = createMediaJobProcessor(application);
  for (let attempts = 0; attempts < 8; attempts += 1) {
    if (!await runOneJob(application, processor)) return;
  }
  assert.fail("测试工作区的媒体分析任务没有在预期次数内清空");
}

function textFromToolResult(result: unknown): string {
  const candidate = result as { content?: Array<{ type?: unknown; text?: unknown }> };
  const first = candidate.content?.[0];
  assert.ok(first && first.type === "text" && typeof first.text === "string", "MCP 应返回标准文本结果");
  return first.text;
}

function readMcpResult<T>(result: unknown): T {
  assert.notEqual((result as { isError?: boolean }).isError, true, textFromToolResult(result));
  return JSON.parse(textFromToolResult(result)) as T;
}

function httpExplainerPlans(input: { evidenceMapBeatId: string; realityMapBeatId: string; snapshotAssetId: string; evidenceCaptureId: string }) {
  return [
    {
      title: "研究原文的适用范围",
      purpose: "让观众先看见原文证据，再理解结论的边界。",
      startFrame: 0,
      endFrame: 24,
      narrativeMapBeatId: input.evidenceMapBeatId,
      kind: "EvidenceDocument",
      primaryTask: "证明结论只能在已观察样本内成立。",
      evidenceCaptureId: input.evidenceCaptureId,
      states: continuousStates(),
      props: { focus: "适用限制" }
    },
    {
      title: "问题发生的现实场景",
      purpose: "将机制从原文证据落回真实环境。",
      startFrame: 24,
      endFrame: 48,
      narrativeMapBeatId: input.realityMapBeatId,
      kind: "RealityBroll",
      primaryTask: "让观众理解这个机制发生在什么场景。",
      assetIds: [input.snapshotAssetId],
      states: continuousStates(),
      props: {}
    }
  ];
}

test("HTTP 入口完整建立 Explainer 证据、Program 与质量读取，错误编译不污染 Revision", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "videocut-explainer-http-"));
  const fixtures = await createEvidenceFixtures(workspaceRoot);
  const server = await createServer({ workspaceRoot });
  try {
    const createdResponse = await server.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Explainer HTTP 入口", profile: "visual_explainer" } });
    assert.equal(createdResponse.statusCode, 201);
    const created = createdResponse.json() as RevisionState;
    const projectId = created.snapshot.project.id;

    const storyResponse = await server.app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/story`,
      payload: {
        baseRevision: created.revision.number,
        title: "从证据到现实的解释",
        summary: "先说明证据边界，再展示现实落点。",
        beats: [
          { title: "原文证据", purpose: "建立可信来源和适用范围" },
          { title: "现实场景", purpose: "让抽象机制落到现实体验" }
        ]
      }
    });
    assert.equal(storyResponse.statusCode, 200);
    const story = storyResponse.json() as RevisionState;

    const documentImportResponse = await server.app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/assets/import-path`,
      payload: { baseRevision: story.revision.number, filePath: fixtures.documentPath }
    });
    assert.equal(documentImportResponse.statusCode, 200);
    const documentImport = documentImportResponse.json() as ImportedAsset;
    const imageImportResponse = await server.app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/assets/import-path`,
      payload: { baseRevision: documentImport.state.revision.number, filePath: fixtures.imagePath }
    });
    assert.equal(imageImportResponse.statusCode, 200);
    const imageImport = imageImportResponse.json() as ImportedAsset;
    await finishQueuedMediaAnalysis(server.application);
    assert.equal(server.application.readProject(projectId).snapshot.assets.every((asset) => asset.status === "ready"), true, "证据只能在媒体分析完成后进入 Explainer 编译");

    const evidenceResponse = await server.app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/evidence-captures`,
      payload: {
        baseRevision: server.application.readProject(projectId).revision.number,
        action: "create",
        sourceAssetId: documentImport.asset.id,
        snapshotAssetId: imageImport.asset.id,
        sourceTitle: "样本研究原文",
        publisher: "测试研究机构",
        sourceUrl: "https://example.test/evidence/source",
        capturedAt: "2026-09-02T00:00:00.000Z",
        pageOrRange: "第 2 页",
        excerpt: "该结果仅适用于本研究观察到的样本。",
        claim: "样本内存在可观察的差异。",
        limitation: "不能直接外推到未被研究覆盖的人群。",
        highlights: [{ x: 0.1, y: 0.2, width: 0.5, height: 0.15, label: "原文限制" }]
      }
    });
    assert.equal(evidenceResponse.statusCode, 200);
    const evidence = evidenceResponse.json() as RevisionState;
    const evidenceCaptureId = evidence.snapshot.evidenceCaptures[0]?.id;
    assert.ok(evidenceCaptureId);
    const readEvidence = await server.app.inject({ method: "GET", url: `/api/projects/${projectId}/evidence-captures?evidenceCaptureId=${evidenceCaptureId}` });
    assert.equal(readEvidence.statusCode, 200);
    assert.equal((readEvidence.json() as { evidenceCaptures: Array<{ id: string }> }).evidenceCaptures[0]?.id, evidenceCaptureId);

    const narrativeResponse = await server.app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/narrative-map`,
      payload: {
        baseRevision: evidence.revision.number,
        viewerQuestion: "这个结论是否可以直接套用到所有场景？",
        promisedModel: "区分证据的适用范围与现实发生地点。",
        conclusion: "观众知道先看证据边界，再理解现实情境。",
        beats: story.snapshot.story.beats.map((beat, index) => ({
          narrativeBeatId: beat.id,
          enteringKnowledge: index === 0 ? "只听过一个结论" : "已看见原文证据",
          question: index === 0 ? "原文究竟说了什么？" : "这个问题发生在哪里？",
          newKnowledge: index === 0 ? "结论存在明确限制" : "现实场景不等于抽象结论本身",
          deferredInformation: index === 0 ? "下一拍再看现实落点" : "没有额外延迟信息",
          claim: index === 0 ? "结论只适用于已观察样本" : "现实素材只承担情境说明",
          evidenceCaptureIds: index === 0 ? [evidenceCaptureId] : []
        }))
      }
    });
    assert.equal(narrativeResponse.statusCode, 200);
    const narrative = narrativeResponse.json() as RevisionState;
    const readNarrative = await server.app.inject({ method: "GET", url: `/api/projects/${projectId}/narrative-map` });
    assert.equal(readNarrative.statusCode, 200);
    assert.equal((readNarrative.json() as { narrativeMap?: { beats: unknown[] } }).narrativeMap?.beats.length, 2);

    const mapBeats = narrative.snapshot.narrativeMap?.beats;
    assert.equal(mapBeats?.length, 2);
    for(const kind of ["HeroReveal","RouteAndFlow","Comparison"]){
      const invalid: {statusCode:number}=await server.app.inject({method:"POST",url:`/api/projects/${projectId}/explainer-scenes/compile`,payload:{baseRevision:narrative.revision.number,plans:[{title:"缺少内容",purpose:"HTTP合同回归",startFrame:0,endFrame:24,narrativeMapBeatId:mapBeats![0]!.id,kind,primaryTask:"测试",states:continuousStates()}]}});
      assert.equal(invalid.statusCode,400);
      assert.equal(server.application.readProject(projectId).revision.number,narrative.revision.number);
    }
    assert.throws(()=>server.application.compileExplainerScenes({projectId,baseRevision:narrative.revision.number,plans:[{title:"原始缺失复现",purpose:"原子失败回归",startFrame:0,endFrame:24,narrativeMapBeatId:mapBeats![0]!.id,kind:"HeroReveal",primaryTask:"测试",states:continuousStates()}]}),error=>(error as {code:string}).code==="HERO_REVEAL_METRIC_REQUIRED");
    assert.equal(server.application.readProject(projectId).revision.number,narrative.revision.number);
    const compileResponse = await server.app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/explainer-scenes/compile`,
      payload: {
        baseRevision: narrative.revision.number,
        plans: httpExplainerPlans({
          evidenceMapBeatId: mapBeats![0]!.id,
          realityMapBeatId: mapBeats![1]!.id,
          snapshotAssetId: imageImport.asset.id,
          evidenceCaptureId
        })
      }
    });
    assert.equal(compileResponse.statusCode, 200);
    const compiled = compileResponse.json() as RevisionState;
    assert.deepEqual(compiled.snapshot.explainerPrograms.map((program) => program.kind), ["EvidenceDocument", "RealityBroll"]);
    const programsResponse = await server.app.inject({ method: "GET", url: `/api/projects/${projectId}/explainer-scenes` });
    assert.equal(programsResponse.statusCode, 200);
    assert.deepEqual((programsResponse.json() as { programs: Array<{ kind: string }> }).programs.map((program) => program.kind), ["EvidenceDocument", "RealityBroll"]);
    const qualityResponse = await server.app.inject({ method: "GET", url: `/api/projects/${projectId}/quality` });
    assert.equal(qualityResponse.statusCode, 200);
    const quality = qualityResponse.json() as { issues: Array<{ code: string; level: string }> };
    assert.equal(quality.issues.some((issue) => issue.level === "blocking" && /^(EVIDENCE_DOCUMENT|REALITY_BROLL)_FACTS_INVALID$/u.test(issue.code)), false, "入口写入的证据与现实素材合同必须能通过确定性质量检查");

    const beforeInvalidRevision = server.application.readProject(projectId).revision.number;
    const invalidCompile = await server.app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/explainer-scenes/compile`,
      payload: {
        baseRevision: beforeInvalidRevision,
        plans: [{
          ...httpExplainerPlans({
            evidenceMapBeatId: mapBeats![0]!.id,
            realityMapBeatId: mapBeats![1]!.id,
            snapshotAssetId: imageImport.asset.id,
            evidenceCaptureId
          })[1],
          assetIds: []
        }]
      }
    });
    assert.equal(invalidCompile.statusCode, 400);
    assert.equal((invalidCompile.json() as { error: string }).error, "REALITY_BROLL_ASSET_REQUIRED");
    assert.equal(server.application.readProject(projectId).revision.number, beforeInvalidRevision, "被拒绝的 HTTP 编译不能覆盖已确认的 Explainer Program");
    const enabledUrl = `/api/projects/${projectId}/explainer-programs/${compiled.snapshot.explainerPrograms[0]!.id}/enabled`;
    const disabledResponse = await server.app.inject({ method: "POST", url: enabledUrl, payload: { baseRevision: beforeInvalidRevision, enabled: false } });
    assert.equal(disabledResponse.statusCode, 200);
    const disabled = disabledResponse.json() as RevisionState;
    assert.equal(disabled.snapshot.explainerPrograms[0]!.disabled, true);
    for (const payload of [{ baseRevision: beforeInvalidRevision, enabled: true }, { baseRevision: disabled.revision.number, enabled: "false" }]) {
      const invalidToggle = await server.app.inject({ method: "POST", url: enabledUrl, payload });
      assert.ok(invalidToggle.statusCode >= 400);
      assert.equal(server.application.readProject(projectId).revision.number, disabled.revision.number);
    }
    const enabledResponse = await server.app.inject({ method: "POST", url: enabledUrl, payload: { baseRevision: disabled.revision.number, enabled: true } });
    assert.equal(enabledResponse.statusCode, 200);
    assert.equal((enabledResponse.json() as RevisionState).snapshot.explainerPrograms[0]!.disabled, false);
  } finally {
    await server.app.close();
    server.application.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("MCP 入口以 snake_case 走完整 Explainer 编译并在错误时保留当前 Revision", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "videocut-explainer-mcp-"));
  const fixtures = await createEvidenceFixtures(workspaceRoot);
  const workerApplication = createApplication(workspaceRoot);
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const transport = new StdioClientTransport({
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["run", "mcp"],
    cwd: process.cwd(),
    env: { ...environment, VIDEOCUT_WORKSPACE: workspaceRoot },
    stderr: "pipe"
  });
  const client = new Client({ name: "videocut-explainer-mcp-entry-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const liveTools = (await client.listTools()).tools;
    const compileTool = liveTools.find(tool => tool.name === "compile_explainer_scenes")!;
    const variants = (compileTool.inputSchema.properties!.plans as {items:{anyOf:Array<{properties:Record<string,any>;required:string[]}>}}).items.anyOf;
    assert.equal(variants.length,12);
    for(const [kind,fields] of Object.entries({HeroReveal:["metric"],RouteAndFlow:["nodes"],Comparison:["leftLabel","rightLabel","dimension"]})) {
      const variant=variants.find(item=>item.properties.kind.const===kind)!;
      assert.ok(variant.required.includes("props"));
      assert.deepEqual(variant.properties.props.required,fields);
    }
    const toolNames = new Set(liveTools.map((tool) => tool.name));
    const evidenceTool = liveTools.find((tool) => tool.name === "manage_evidence_capture")!;
    assert.match(evidenceTool.description!, /create 必须提供.*1到12个 highlights/u);
    assert.match(evidenceTool.description!, /update 省略字段会保留原值.*remove 无需 highlights/u);
    const highlightSchema = evidenceTool.inputSchema.properties!.highlights as { description: string; items: { properties: Record<string, { description: string }> } };
    assert.match(highlightSchema.description, /不包含播放器留白或画布尺寸/u);
    assert.match(highlightSchema.items.properties.x!.description, /页面快照宽度.*不是像素/u);
    assert.match(highlightSchema.items.properties.y!.description, /页面快照高度.*不是像素/u);
    assert.match(highlightSchema.items.properties.width!.description, /x\+width<=1/u);
    assert.match(highlightSchema.items.properties.height!.description, /y\+height<=1/u);
    for (const name of ["import_media", "read_narrative_map", "manage_narrative_map", "read_evidence_capture", "manage_evidence_capture", "read_explainer_scene_programs", "compile_explainer_scenes", "read_quality_report"]) {
      assert.ok(toolNames.has(name), `MCP 缺少阶段 3 入口：${name}`);
    }

    const created = readMcpResult<RevisionState>(await client.callTool({ name: "create_project", arguments: { name: "Explainer MCP 入口", profile: "visual_explainer" } }));
    const projectId = created.snapshot.project.id;
    const targeted = readMcpResult<{ projectId: string }>(await client.callTool({ name: "target_project", arguments: { project_id: projectId } }));
    assert.equal(targeted.projectId, projectId);
    const story = readMcpResult<RevisionState>(await client.callTool({ name: "manage_story", arguments: {
      base_revision_id: created.revision.number,
      title: "MCP 证据解释",
      summary: "验证 snake_case 到项目对象的映射。",
      beats: [
        { title: "来源证据", purpose: "建立可信来源" },
        { title: "现实场景", purpose: "建立现实理解" }
      ]
    } }));
    const documentImport = readMcpResult<ImportedAsset>(await client.callTool({ name: "import_media", arguments: {
      base_revision_id: story.revision.number,
      file_path: fixtures.documentPath,
      role: "evidence",
      provenance: { source: "local_import", }
    } }));
    const imageImport = readMcpResult<ImportedAsset>(await client.callTool({ name: "import_media", arguments: {
      base_revision_id: documentImport.state.revision.number,
      file_path: fixtures.imagePath,
      role: "evidence",
      provenance: { source: "local_import", }
    } }));
    await finishQueuedMediaAnalysis(workerApplication);
    const analyzedRevision = workerApplication.readProject(projectId).revision.number;
    const evidence = readMcpResult<RevisionState>(await client.callTool({ name: "manage_evidence_capture", arguments: {
      base_revision_id: analyzedRevision,
      action: "create",
      source_asset_id: documentImport.asset.id,
      snapshot_asset_id: imageImport.asset.id,
      source_title: "MCP 原始资料",
      publisher: "测试研究机构",
      source_url: "https://example.test/mcp-evidence",
      captured_at: "2026-09-02T00:00:00.000Z",
      page_or_range: "第 2 页",
      excerpt: "此结果只描述已经观察到的样本。",
      claim: "样本内可以观察到差异。",
      limitation: "没有覆盖的人群不能直接推断。",
      highlights: [{ x: 0.1, y: 0.2, width: 0.5, height: 0.15, label: "限制" }]
    } }));
    const evidenceCaptureId = evidence.snapshot.evidenceCaptures[0]?.id;
    assert.ok(evidenceCaptureId);
    const readEvidence = readMcpResult<{ evidenceCaptures: Array<{ id: string }> }>(await client.callTool({ name: "read_evidence_capture", arguments: { evidence_capture_id: evidenceCaptureId } }));
    assert.equal(readEvidence.evidenceCaptures[0]?.id, evidenceCaptureId);
    const narrative = readMcpResult<RevisionState>(await client.callTool({ name: "manage_narrative_map", arguments: {
      base_revision_id: evidence.revision.number,
      viewer_question: "证据和现实场景分别说明什么？",
      promised_model: "证据解释可信边界，现实素材建立具体情境。",
      conclusion: "两种视觉职责不能互相伪装。",
      beats: story.snapshot.story.beats.map((beat, index) => ({
        narrative_beat_id: beat.id,
        entering_knowledge: index === 0 ? "只听过一个结论" : "已经看见来源限制",
        question: index === 0 ? "来源实际说了什么？" : "现实中在哪里发生？",
        new_knowledge: index === 0 ? "结论有适用边界" : "现实素材不等于原文举证",
        deferred_information: index === 0 ? "下一拍再给出现实情境" : "没有额外延迟信息",
        claim: index === 0 ? "原文限定适用范围" : "现实 B-roll 只承担情境职责",
        evidence_capture_ids: index === 0 ? [evidenceCaptureId] : []
      }))
    } }));
    const mapBeats = narrative.snapshot.narrativeMap?.beats;
    assert.equal(mapBeats?.length, 2);
    for(const kind of ["HeroReveal","RouteAndFlow","Comparison"]){
      const rejected=await client.callTool({name:"compile_explainer_scenes",arguments:{base_revision_id:narrative.revision.number,plans:[{title:"缺少内容",purpose:"验证参数可发现且拒绝无写入",start_frame:0,end_frame:24,narrative_map_beat_id:mapBeats![0]!.id,kind,primary_task:"测试",states:continuousMcpStates()}]}});
      assert.equal(rejected.isError,true);
      assert.ok(textFromToolResult(rejected).length>0);
      assert.equal(workerApplication.readProject(projectId).revision.number,narrative.revision.number);
    }
    const compiled = readMcpResult<RevisionState>(await client.callTool({ name: "compile_explainer_scenes", arguments: {
      base_revision_id: narrative.revision.number,
      plans: [
        {
          title: "MCP 证据文档",
          purpose: "在页面环境中显示来源和限定条件。",
          start_frame: 0,
          end_frame: 24,
          narrative_map_beat_id: mapBeats![0]!.id,
          kind: "EvidenceDocument",
          primary_task: "建立来源与限制。",
          evidence_capture_id: evidenceCaptureId,
          states: continuousMcpStates(),
          props: { focus: "限定条件" }
        },
        {
          title: "MCP 现实场景",
          purpose: "展示真实环境，而不把它当成文档证据。",
          start_frame: 24,
          end_frame: 48,
          narrative_map_beat_id: mapBeats![1]!.id,
          kind: "RealityBroll",
          primary_task: "将抽象结论落回情境。",
          asset_ids: [imageImport.asset.id],
          states: continuousMcpStates(),
          props: {}
        }
      ]
    } }));
    assert.deepEqual(compiled.snapshot.explainerPrograms.map((program) => program.kind), ["EvidenceDocument", "RealityBroll"]);
    const programs = readMcpResult<{ programs: Array<{ kind: string; status: string }> }>(await client.callTool({ name: "read_explainer_scene_programs", arguments: {} }));
    assert.deepEqual(programs.programs.map((program) => program.kind), ["EvidenceDocument", "RealityBroll"]);
    const quality = readMcpResult<{ issues: Array<{ code: string; level: string }> }>(await client.callTool({ name: "read_quality_report", arguments: {} }));
    assert.equal(quality.issues.some((issue) => issue.level === "blocking" && /^(EVIDENCE_DOCUMENT|REALITY_BROLL)_FACTS_INVALID$/u.test(issue.code)), false);

    const beforeInvalidRevision = workerApplication.readProject(projectId).revision.number;
    const invalid = await client.callTool({ name: "compile_explainer_scenes", arguments: {
      base_revision_id: beforeInvalidRevision,
      plans: [{
        title: "无素材现实场景",
        purpose: "验证拒绝路径不污染项目。",
        start_frame: 48,
        end_frame: 72,
        narrative_map_beat_id: mapBeats![1]!.id,
        kind: "RealityBroll",
        primary_task: "不应允许空现实素材。",
        states: continuousMcpStates(),
        props: {}
      }]
    } });
    assert.equal((invalid as { isError?: boolean }).isError, true);
    assert.match(textFromToolResult(invalid), /RealityBroll 必须绑定/u);
    assert.equal(JSON.parse(textFromToolResult(invalid)).code,"REALITY_BROLL_ASSET_REQUIRED");
    assert.equal(workerApplication.readProject(projectId).revision.number, beforeInvalidRevision, "MCP 被拒绝的编译不能覆盖当前 Explainer Revision");
    assert.ok(toolNames.has("set_explainer_program_enabled"));
    const toggle = { program_id: compiled.snapshot.explainerPrograms[0]!.id, enabled: false };
    const disabled = readMcpResult<RevisionState>(await client.callTool({ name: "set_explainer_program_enabled", arguments: { base_revision_id: beforeInvalidRevision, ...toggle } }));
    assert.equal(disabled.snapshot.explainerPrograms[0]!.disabled, true);
    const staleToggle = await client.callTool({ name: "set_explainer_program_enabled", arguments: { base_revision_id: beforeInvalidRevision, ...toggle, enabled: true } });
    assert.equal(staleToggle.isError, true);
    assert.equal(workerApplication.readProject(projectId).revision.number, disabled.revision.number);
    const enabled = readMcpResult<RevisionState>(await client.callTool({ name: "set_explainer_program_enabled", arguments: { base_revision_id: disabled.revision.number, ...toggle, enabled: true } }));
    assert.equal(enabled.snapshot.explainerPrograms[0]!.disabled, false);
  } finally {
    await transport.close().catch(() => undefined);
    workerApplication.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
