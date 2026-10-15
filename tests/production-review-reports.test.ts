import {test} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {promises as fs} from 'node:fs';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {registerProductionTools} from '../apps/server/src/production/speech-tools.js';
import {writeJson} from '../packages/production-service/src/files.js';
import {reviewFixture,complete,observations,code} from './helpers/production-review.js';

function report(reviewId:string,results:Array<ReturnType<typeof complete>>){
 return {reviewId,results:results.map(({reviewId,...result})=>result)};
}

test('一次接收多个作者报告，单文件也可提交多个单元；部分观察与重试沿原身份保存',async()=>{
 const f=await reviewFixture();try{
  await f.version('v1');const plan=await f.plan('v1'),a=f.assign(plan.reviewId),b=f.assign(plan.reviewId,'unit-1','native-b');
  const first='records/review-results/a.json',second='records/review-results/b.json';
  await writeJson(join(f.root,first),report(plan.reviewId,[{...complete(a),observations:observations(a).slice(0,1)}]));
  await writeJson(join(f.root,second),report(plan.reviewId,[complete(b)]));
  const input={reportRefs:[first,second]},accepted=await f.service.submitReports(f.run.runId,input);
  assert.deepEqual(accepted.results.map(r=>r.status),['partial','complete']);
  assert.equal(f.service.read(f.run.runId,plan.reviewId).observationCount,3);
  assert.deepEqual(await f.service.submitReports(f.run.runId,input),accepted);
  assert.equal((f.repo.db.prepare('SELECT COUNT(*) n FROM review_submissions').get() as any).n,2);
  // 已接受的原报告不因媒体随后变化而丢失；新增观察仍必须校验实际证据。
  await fs.appendFile(b.evidence[0].path,'后续变化');assert.deepEqual(await f.service.submitReports(f.run.runId,input),accepted);
  await writeJson(join(f.root,first),report(plan.reviewId,[complete(a),complete(b)]));
  const finished=await f.service.submitReports(f.run.runId,{reportRefs:[first]});
  assert.ok(finished.results.every(r=>r.status==='complete'));assert.equal(f.service.read(f.run.runId,plan.reviewId).remaining,0);
 }finally{await f.close();}
});

test('同批报告范围错误原子回滚；不同轮与旧内联输入拒绝，不留下半份提交',async()=>{
 const f=await reviewFixture();try{
  await f.version('v1');const plan=await f.plan('v1'),a=f.assign(plan.reviewId),b=f.assign(plan.reviewId,'unit-1','native-b'),ref='records/review-results/round.json';
  await writeJson(join(f.root,ref),report(plan.reviewId,[complete(a),{...complete(b),observations:[{...observations(b)[0],checkId:'错误检查'}]}]));
  await assert.rejects(f.service.submitReports(f.run.runId,{reportRefs:[ref]}),code('REVIEW_EVIDENCE_SCOPE'));
  assert.equal(f.service.read(f.run.runId,plan.reviewId).observationCount,0);assert.equal((f.repo.db.prepare('SELECT COUNT(*) n FROM review_submissions').get() as any).n,0);
  await assert.rejects(f.service.submitReports(f.run.runId,complete(a)));
  const other='records/review-results/other.json';await writeJson(join(f.root,other),report('00000000-0000-4000-8000-000000000001',[complete(b)]));
  await assert.rejects(f.service.submitReports(f.run.runId,{reportRefs:[ref,other]}),code('REVIEW_REPORT_MIXED'));
  await writeJson(join(f.root,ref),report(plan.reviewId,[complete(a),complete(b)]));
  assert.ok((await f.service.submitReports(f.run.runId,{reportRefs:[ref]})).results.every(r=>r.accepted));
 }finally{await f.close();}
});

test('报告交接保留部分观察；接替后旧报告只留迟到记录，新负责人继续剩余范围',async()=>{
 const f=await reviewFixture();try{
  await f.version('v1');const plan=await f.plan('v1'),a=f.assign(plan.reviewId),b=f.assign(plan.reviewId,'unit-1','native-b'),ref='records/review-results/a.json';
  await writeJson(join(f.root,ref),report(plan.reviewId,[{...complete(a),observations:observations(a).slice(0,1),status:'partial'}]));
  await f.service.submitReports(f.run.runId,{reportRefs:[ref]});
  const replacement=f.service.assign(f.run.runId,{reviewId:plan.reviewId,unitId:'unit-0',reviewerAgentId:'native-next',assignmentRequestId:'replacement',previousAssignmentToken:a.assignmentToken,reason:'原负责人退出，保留已观察部分'});
  assert.equal(replacement.observations.length,1);
  await writeJson(join(f.root,ref),report(plan.reviewId,[complete(a),complete(b)]));
  const late=await f.service.submitReports(f.run.runId,{reportRefs:[ref]});assert.equal(late.results[0].code,'REVIEW_ASSIGNMENT_STALE');assert.equal(late.results[0].accepted,false);assert.equal(late.results[1].accepted,true);
  assert.deepEqual(await f.service.submitReports(f.run.runId,{reportRefs:[ref]}),late);
  const state=f.service.read(f.run.runId,plan.reviewId);assert.equal(state.units[0].observations.length,1);assert.equal(state.remaining,1);
  const next='records/review-results/next.json';await writeJson(join(f.root,next),report(plan.reviewId,[complete(replacement)]));
  await f.service.submitReports(f.run.runId,{reportRefs:[next]});assert.equal(f.service.read(f.run.runId,plan.reviewId).remaining,0);
 }finally{await f.close();}
});

test('实际 MCP 只公开报告引用，同源说明完整且调用接收真实文件',async()=>{
 const f=await reviewFixture(),server=new McpServer({name:'审片文件交接测试',version:'1'}),client=new Client({name:'主协调夹具',version:'1'});
 try{
  await f.version('v1');const plan=await f.plan('v1'),a=f.assign(plan.reviewId),ref='records/review-results/native.json';await writeJson(join(f.root,ref),report(plan.reviewId,[complete(a)]));
  registerProductionTools(server,async(name,input)=>{assert.equal(name,'submit_review');return f.service.submitReports(f.run.runId,input);});
  const [left,right]=InMemoryTransport.createLinkedPair();await server.connect(left);await client.connect(right);
  const tool=(await client.listTools()).tools.find(t=>t.name==='submit_review')!;assert.deepEqual(tool.inputSchema.required,['reportRefs']);
  const schema=JSON.parse((tool.inputSchema.properties?.reportRefs as any).items.description.split('完整结构：')[1]);
  assert.deepEqual(schema.required,['reviewId','results']);assert.ok(schema.properties.results.items.properties.issueResolutions);
  const received=await client.callTool({name:'submit_review',arguments:{reportRefs:[ref]}});assert.notEqual(received.isError,true);assert.equal((received.structuredContent as any).results[0].status,'complete');
 }finally{await client.close();await server.close();await f.close();}
});
