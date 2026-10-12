/** 固定开发样本对照；只写隔离工作区，不把有限标注当作全库召回率。 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createApplication } from "@videocut/application";
import { readRuntimeConfig } from "@videocut/project-overview";
import { ComfyUIBridgeClient } from "@videocut/bridge";
import { processClaimedJob } from "@videocut/job-runtime";
import { loadLibraryIndex, searchLibraryIndex } from "../references/motion-cases/skillry/tools/library-store.mjs";
import { mechanismChunks, motionCacheKey } from "../packages/media-intelligence/src/motion-library.js";
import { cosine } from "../packages/media-intelligence/src/index.js";
import { runMotionLibrarySearch, runMotionReferenceAnalysis } from "../apps/job-worker/src/motion-library.js";

const directory = resolve(process.argv[2] ?? ".repair-validation/continuous-semantic");
const app = createApplication(directory), config = readRuntimeConfig();
const bridge = new ComfyUIBridgeClient(config.bridge.apiBaseUrl);
// 固定开发前基线，后续提交也能复现同一词法程序。
const baselineRef = "9b6b10a3679e280fa485e7250a419dadea5189bb";
try {
  const library = resolve("references/motion-cases/skillry"), index = loadLibraryIndex(library);
  const cases = JSON.parse(await readFile("tests/fixtures/motion-retrieval-cases.json", "utf8")) as Array<{id:string;source:string;intent:string;query:string;acceptable:Array<{id:string;reason:string}>}>;
  // 使用基线提交的真实词法程序，仅在开发运行内导入，原件及活动索引不改。
  let original = execFileSync("git", ["show", `${baselineRef}:references/motion-cases/skillry/mechanism-search.mjs`], { encoding: "utf8", windowsHide: true });
  for (const file of ["taxonomy.mjs", "selection.mjs"]) original = original.replaceAll(`'./${file}'`, JSON.stringify(pathToFileURL(join(library, file)).href));
  const baseline = await import(`data:text/javascript;base64,${Buffer.from(original).toString("base64")}`);
  const state = app.createProject({ name: "固定需求检索对照（隔离开发）" }), projectId = state.snapshot.project.id;
  const modelConfig = { ...config.semantic, apiBaseUrl: config.bridge.apiBaseUrl };
  const runSearch = async (stages: string[]) => {
    app.repository.createJob({ projectId, kind: "motion_library_search", idempotencyKey: randomUUID(), payload: { request: { stages, limit: 12 }, source_sha256: index.source_sha256, modelConfig } });
    const job = app.claimNextJob(["motion_library_search"], 60000)!;
    await processClaimedJob(app, job, value => runMotionLibrarySearch(app, value, bridge));
    const done = app.trackJob(job.id);
    if (done.status !== "succeeded") throw new Error(JSON.stringify(done));
    return done;
  };
  const results = new Map<string, any>(), runs = [];
  const queries = cases.flatMap(entry => [entry.intent, entry.query]);
  for (let offset = 0; offset < queries.length; offset += 8) {
    const job = await runSearch(queries.slice(offset, offset + 8));
    runs.push({ jobId: job.id, diagnostics: job.result!.diagnostics });
    for (const group of job.result!.groups as any[]) results.set(group.stage, group);
    console.log(JSON.stringify({ completed: Math.min(offset + 8, queries.length), total: queries.length, diagnostics: job.result!.diagnostics }));
  }
  const warm = await runSearch(queries.slice(0, 8));
  const schema = await bridge.getWorkflow(config.semantic.embeddingWorkflowId), version = { ...modelConfig, schema: schema.schemaVersion };
  const documents = index.mechanisms.flatMap(mechanism => mechanismChunks(mechanism.search_text).map((text, chunk) => ({ id: mechanism.id, vector: app.intelligence.store.libraryCache<number[]>(motionCacheKey(index.source_sha256, [mechanism.id, mechanism.text_sha256, chunk, text], version, "document"))! })));
  const rows = cases.map(entry => {
    const vector = app.intelligence.store.libraryCache<number[]>(motionCacheKey(index.source_sha256, entry.query.trim().normalize("NFC"), version, "query"))!;
    const scores = new Map<string,number>();
    for (const doc of documents) scores.set(doc.id, Math.max(scores.get(doc.id) ?? -1, cosine(vector, doc.vector)));
    const compact = (cards: any[]) => cards.slice(0,12).map(card => ({ id:card.id, score:card.score, evidence:card.retrieval_evidence }));
    return { ...entry, old_lexical:compact(baseline.queryMechanisms(index,{query:entry.query,limit:12}).cards), fulltext:compact((searchLibraryIndex(index,{query:entry.query,limit:12}) as any).cards), vector:[...scores].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,12).map(([id,score])=>({id,score})), hybrid:compact(results.get(entry.query).cards), raw_intent_hybrid:compact(results.get(entry.intent).cards) };
  });
  const methods = ["old_lexical", "fulltext", "vector", "hybrid", "raw_intent_hybrid"] as const;
  const summary = Object.fromEntries(methods.map(method => [method, { queries_with_labeled_candidate_at_12:rows.filter(row=>row[method].some(card=>row.acceptable.some(accepted=>accepted.id===card.id))).length, total:rows.length }]));
  const report = { source_sha256:index.source_sha256, baseline_commit:baselineRef, model:config.semantic.embeddingRevision, schema:schema.schemaVersion, limitation:"来自文档与机制原文的开发派生需求，非用户历史查询；有限标注只报告前12项是否出现已标注候选，不是全库Recall、精确率或创作质量。", summary, runs, warm:{jobId:warm.id,diagnostics:warm.result!.diagnostics}, revision:app.readProject(projectId).revision.number, rows };
  await writeFile(join(directory,"retrieval-evaluation.json"),JSON.stringify(report,null,2));
  console.log(JSON.stringify({summary,warm:report.warm,revision:report.revision}));
  if(process.argv.includes("--reference")) {
    const submitted=app.repository.createJob({projectId,kind:"motion_reference_analysis",idempotencyKey:randomUUID(),payload:{id:"014-m01",source_sha256:index.source_sha256,range:{startMs:0,endMs:3000},modelConfig}});
    const job=app.claimNextJob(["motion_reference_analysis"],60000)!;
    await processClaimedJob(app,job,value=>runMotionReferenceAnalysis(app,value,bridge));
    const done=app.trackJob(submitted.id);
    await writeFile(join(directory,"reference-live.json"),JSON.stringify(done,null,2));
    if(done.status!=="succeeded")throw new Error(JSON.stringify(done));
    const cached=await runMotionReferenceAnalysis(app,done,bridge);
    console.log(JSON.stringify({reference:done.id,status:done.status,cache_hit:cached.cache_hit,sampling:cached.sampling,revision:app.readProject(projectId).revision.number}));
  }
} finally { app.close(); }
