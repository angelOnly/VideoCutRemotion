import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {PNG} from 'pngjs';
import {ProductionRepository} from '../../packages/production-service/src/repository.js';
import {ReviewService,type ReviewWork} from '../../packages/production-service/src/review-service.js';
import {sha256} from '../../packages/production-service/src/contracts.js';
import {treeDigest,writeJson} from '../../packages/production-service/src/files.js';
// 全部观察是隔离协议夹具，不作为真实作品的看听记录或质量批准。
export async function reviewFixture(){
 const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'review-service-'))),repo=new ProductionRepository(join(root,'isolated.sqlite'));
 repo.accept('test','analysis',{taskId:'isolated-review',content:'甲乙',otherRequirements:'',plugin:{customTemplateId:'test'}});
 const analysis=repo.claim()!;repo.finish(analysis.runId,analysis.token,'succeeded',{});
 repo.accept('test','render',{taskId:'isolated-review',basePlanVersion:analysis.planVersion,otherRequirements:'',dataList:[{id:'s0',content:'甲'},{id:'s1',content:'乙'}]});
 const run=repo.claim()!,service=new ReviewService(repo,()=>root);
 async function version(id:string,phase:'pre_export'='pre_export',update?:(timeline:any)=>void){
  const project=join(root,'preview-snapshots',id,'project'),renderer=join(project,'renderer');
  await fs.mkdir(join(renderer,'public'),{recursive:true});await fs.writeFile(join(project,'说明.md'),'隔离测试');await fs.writeFile(join(renderer,'index.tsx'),'// 隔离结构夹具');await fs.writeFile(join(renderer,'timeline.ts'),'export default {};');
  await writeJson(join(renderer,'renderer-manifest.json'),{schemaVersion:1,templateVersion:'test',instructions:['../说明.md'],entry:'index.tsx',timelineModule:'timeline.ts',wholeComposition:'Main',publicAssetRoot:'public',width:64,height:64,fps:24,voiceRefs:[]});
  const timeline={fps:24,totalFrames:12,scenes:[0,1].map(i=>({id:`s${i}`,from:i*6,frames:6,utterances:[{id:`u${i}`,src:`${i}.wav`,startFrame:0,endFrameExclusive:6}],captions:[{text:i?'乙':'甲',startFrame:0,endFrameExclusive:6,utteranceId:`u${i}`}]}))};update?.(timeline);await writeJson(join(project,'timeline.json'),timeline);
  const readyFrames=[];
  for(const frame of [0,3,6,9]){const path=join(root,`${id}-${frame}.png`),png=new PNG({width:64,height:64});png.data.fill(255);png.data[0]=frame;const bytes=PNG.sync.write(png);await fs.writeFile(path,bytes);readyFrames.push({frame,path,sha256:sha256(bytes)});}
  const sourceDigest=await treeDigest(project),job={id,runId:run.runId,kind:'frame-preview',state:'succeeded',sourceDigest,input:{previewOnly:true},readyFrames,readyFiles:[]};
  await writeJson(join(root,'render-jobs',`${id}.json`),job);return {project,sourceDigest,job};
 }
 const units=(id:string)=>[0,1].map(i=>({unitId:`unit-${i}`,sceneIds:[`s${i}`],checks:[{checkId:'meaning',purpose:'解释本场关系',mode:'image',evidence:[i*6,i*6+3].map(frame=>({renderRequestId:id,frame}))}]}));
 const input=(id:string)=>({renderRequestIds:[id],phase:'pre_export',timelineRef:'timeline.json',units:units(id)});
 const plan=(id:string)=>service.prepare(run,input(id));
 const assign=(reviewId:string,unitId='unit-0',reviewerAgentId='native-agent')=>service.assign(run.runId,{reviewId,unitId,reviewerAgentId,assignmentRequestId:randomUUID()});
 return {root,repo,run,service,version,units,input,plan,assign,async close(){service.close();repo.close();await fs.rm(root,{recursive:true,force:true});}};
}
export function observations(work:ReviewWork){return work.checks.flatMap(check=>check.mode==='image'?check.evidenceIds.map(evidenceId=>({checkId:check.checkId,evidenceId,note:'隔离协议观察夹具'})):[{checkId:check.checkId,evidenceId:check.evidenceIds[0],note:'隔离连续观察夹具',range:check.range}]);}
export const complete=(work:ReviewWork&{reviewId:string;assignmentToken:string})=>({reviewId:work.reviewId,assignmentToken:work.assignmentToken,observations:observations(work),issues:[],status:'complete'});
export const code=(expected:string)=>(error:any)=>error?.code===expected;
