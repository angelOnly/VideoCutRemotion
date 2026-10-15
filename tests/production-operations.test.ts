import test from 'node:test';
import assert from 'node:assert/strict';
import {analysisRequestSchema,analysisResultSchema,sceneSchema} from '../packages/production-service/src/contracts.js';
import {parseSceneScript} from '../packages/production-service/src/scene-script.js';
import {speechBindings} from '../packages/production-service/src/scene-speech.js';
import {validateProductionTimeline} from '../packages/production-service/src/production-timeline.js';
import {normalizeWebAnalysis,normalizeWebRender} from '../packages/production-service/src/web-contract.js';
import {ProductionRepository} from '../packages/production-service/src/repository.js';

const template={speakerBindings:{采访员:{speaker:'interviewer',voiceRef:'interview.voice'},工程师:{speaker:'engineer',voiceRef:'engineer.voice'}}};
const request={taskId:'test',content:'【工程师 亮相】（工程师出镜）今天拆浩欧博。',otherRequirements:'',plugin:{customTemplateId:'finance'}};
const result=()=>({taskId:'test',runId:'00000000-0000-4000-8000-000000000001',inputDigest:'test',context:'采用工程师台词及出镜安排',dataList:[{id:'s1',content:'【工程师】【画面：工程师出镜】今天拆浩欧博。',dur:3,durationSource:'estimated'}]});

test('双栏及可见标签合同，普通括号和未标记正文原样保留',()=>{
 const base={taskId:'single-input',plugin:{customTemplateId:'finance'}};
 for(const parse of [(v:unknown)=>analysisRequestSchema.parse(v),normalizeWebAnalysis]){
  for(const input of [{content:' 原文。\n'},{otherRequirements:' 需求。\n'},{content:'原文。',otherRequirements:'需求。'},{content:'',otherRequirements:'需求。'},{content:'原文。',otherRequirements:''}]){
   const parsed=parse({...base,...input});assert.equal(parsed.content,input.content??'');assert.equal(parsed.otherRequirements,input.otherRequirements??'');
  }
  for(const input of [{},{content:''},{otherRequirements:''},{content:' \n',otherRequirements:'\t'}])assert.throws(()=>parse({...base,...input}),/至少一栏/);
 }
 for(const content of ['', '  '])assert.equal(normalizeWebAnalysis({...request,content,otherRequirements:'台词（含括号）。'}).content,content);
 assert.throws(()=>analysisRequestSchema.parse({...request,content:' ',otherRequirements:'\n'}));
 const r=analysisResultSchema.parse(result());assert.equal('directing' in r.dataList[0],false);
 assert.throws(()=>analysisResultSchema.parse({...result(),sourceMap:[]}));
 const script='【采访员】收入（含税）1.2亿。\n【工程师】同比增长😀20%。【画面：展示收入图】';
 const scene=parseSceneScript({id:'s',content:script},template);assert.equal(scene.submittedContent,script);assert.equal(scene.content,'收入（含税）1.2亿。\n同比增长😀20%。');
 assert.deepEqual(scene.directing!.speechTurns.map(t=>[t.speakerId,scene.content.slice(t.start,t.end)]),[['采访员','收入（含税）1.2亿。\n'],['工程师','同比增长😀20%。']]);
 assert.deepEqual(scene.directing!.visualDirections,['展示收入图']);
 assert.deepEqual(parseSceneScript({id:'s',content:'  普通（括号）正文。\n'}),{id:'s',content:'  普通（括号）正文。\n'});
});
test('标签改人、拆并及重排从当前文本重新计算，无口播必须明确且不掩盖台词',()=>{
 const make=(content:string)=>parseSceneScript({id:'s',content},template);
 const a=make('【工程师】新句。'),b=make('【采访员】另一句。');
 const merged=make(b.submittedContent!+a.submittedContent!);assert.deepEqual(merged.directing!.speechTurns.map(t=>t.speakerId),['采访员','工程师']);
 assert.equal(make('【工程师】新句。').directing!.speechTurns[0].end,3);
 const visual=make('【章节：企业概况】【无口播：2.5秒】【画面：展示图表】');assert.equal(visual.content,'');assert.equal(visual.directing!.durationSec,2.5);
 for(const content of ['【工程师','【未知人物】台词。','【画面：图表】','【无口播：0秒】【画面：图表】','【无口播：3601秒】【画面：图表】','【无口播：2秒】','【无口播：2秒】【画面：图表】这是台词','【无口播：2秒】【无口播：3秒】【画面：图表】'])assert.throws(()=>make(content),content);
});
test('人物轮次范围完整且不能拆开字符，句段不得跨人或配错音色',()=>{
 const scene:any={id:'s',content:'甲。乙。',directing:{kind:'speech',speechTurns:[{id:'a',speakerId:'采访员',start:0,end:2},{id:'b',speakerId:'工程师',start:2,end:4}],visualDirections:[]}};
 const bound=speechBindings(scene,[{id:'u1',text:'甲。',voiceRef:'interview.voice'},{id:'u2',text:'乙。',voiceRef:'engineer.voice'}],false,{speakerBindings:{采访员:{speaker:'interviewer',voiceRef:'interview.voice'},工程师:{speaker:'engineer',voiceRef:'engineer.voice'}}});assert.equal(bound[1]?.speaker,'engineer');assert.equal(bound[0]?.turnId,'a');
 assert.throws(()=>speechBindings(scene,[{id:'u',text:'甲。乙。',voiceRef:'interview.voice'}]),/跨越/);
 assert.throws(()=>speechBindings(scene,[{id:'u1',text:'甲。',voiceRef:'engineer.voice'},{id:'u2',text:'乙。'}],false,{speakerBindings:{采访员:{speaker:'interviewer',voiceRef:'interview.voice'},工程师:{speaker:'engineer',voiceRef:'engineer.voice'}}}),/音色/);
 scene.directing.speechTurns[1].start=3;assert.throws(()=>sceneSchema.parse(scene));
 scene.content='😀甲。';scene.directing.speechTurns[0].end=1;scene.directing.speechTurns[1].start=1;assert.throws(()=>sceneSchema.parse(scene));
});
test('现有网页提交无需新增字段，当前改句和标签持久化，旧人物及旧镜头不恢复',()=>{
 const repo=new ProductionRepository(':memory:');try{
 const a=repo.accept('a','analysis',request),claimed=repo.claim()!;repo.checkpoint(a.runId,claimed.token!,{template:{manifest:template}});repo.finish(a.runId,claimed.token,'succeeded',result());
 const input={taskId:'test',dataList:[{id:'new',content:'【采访员】网页新增台词。',dur:8,extraData:{keywordList:[]}}]};
 const normalized=normalizeWebRender(input,repo.list('a','test'));assert.equal(normalized.basePlanVersion,a.planVersion);assert.equal(normalized.otherRequirements,'');
 assert.equal(normalized.dataList.length,1);assert.equal(normalized.dataList[0].id,'new');assert.equal(normalized.dataList[0].content,'网页新增台词。');assert.equal(normalized.dataList[0].directing!.speechTurns[0].speakerId,'采访员');
 const r=repo.accept('a','render',normalized);assert.deepEqual(r.request,JSON.parse(JSON.stringify(normalized)));assert.equal(repo.accept('a','render',normalized).runId,r.runId);
 const changed=normalizeWebRender({...input,dataList:[{id:'new',content:'【工程师】网页新增台词。'}]},repo.list('a','test'));assert.notEqual(repo.accept('a','render',changed).runId,r.runId);
 const plain=normalizeWebRender({...input,dataList:[{id:'new',content:'网页新增台词。'}]},repo.list('a','test'));assert.equal(plain.dataList[0].directing,undefined);
 repo.accept('a','analysis',{...request,otherRequirements:'新版'});
 assert.throws(()=>normalizeWebRender(input,repo.list('a','test')),/最新 Analysis/);
 }finally{repo.close();}
});
test('无口播场景连续切分，模板专属字段不由通用链路解释，口播缺音频仍失败',()=>{
 const visual:any={id:'v',content:'',directing:{kind:'visual',speechTurns:[],visualDirections:['展示图表'],durationSec:2}};
 const timeline:any={fps:30,totalFrames:60,scenes:[{id:'v',from:0,frames:60,utterances:[],captions:[],intro:{src:'intro.mp4',fromFrame:0,frames:30,companyName:null}}]};
 assert.deepEqual(validateProductionTimeline(timeline,[visual],30).ranges,[{id:'v',fromFrame:0,toFrame:60}]);
 assert.throws(()=>validateProductionTimeline(timeline,[{id:'v',content:'正文'}],30));
 timeline.scenes[0].intro.companyName='模板自定标题';validateProductionTimeline(timeline,[visual],30);
 delete timeline.scenes[0].intro;timeline.scenes[0].frames=59;assert.throws(()=>validateProductionTimeline(timeline,[visual],30));
 assert.throws(()=>sceneSchema.parse({...visual,content:'不能掩盖口播'}));
});

test('人物绑定来自模板，普通人物不按财经音色猜测，明确声明才能约束',()=>{
 const scene:any={id:'custom',content:'原句',directing:{kind:'speech',speechTurns:[{id:'turn',speakerId:'采访员',start:0,end:2}],visualDirections:[]}};
 const segment={id:'voice',text:'原句',voiceRef:'custom.voice'};
 assert.throws(()=>speechBindings(scene,[segment]),/未知模板人物/);
 assert.equal(speechBindings(scene,[segment],false,{speakerBindings:{采访员:{speaker:'custom.actor',voiceRef:'custom.voice'}}})[0]?.speaker,'custom.actor');
 scene.directing.speechTurns[0].speakerId=null;
 assert.deepEqual(speechBindings(scene,[{...segment,voiceRef:'interview.voice'}]),[{turnId:'turn'}]);
});

// 同样的可见人物名由各模板各自绑定，不依赖任何栏目名单。
test('人物标签由冻结模板决定，模板切换后拒绝旧人物；内部提交使用指定分析版本',()=>{
 const scene={id:'s',content:'【向导】出发。'};
 const first={speakerBindings:{向导:{speaker:'guide',voiceRef:'guide.voice'}}};
 const second={speakerBindings:{教师:{speaker:'teacher',voiceRef:'teacher.voice'}}};
 const parsed=parseSceneScript(scene,first);assert.equal(parsed.directing!.speechTurns[0].speakerId,'向导');
 assert.throws(()=>parseSceneScript(scene,second),/当前模板/);
 assert.throws(()=>parseSceneScript({id:'s',content:'【财小策】不属于本模板。'},first),/当前模板/);
 const runs:any=[{taskId:'t',stage:'analysis',planVersion:1,checkpoint:{template:{manifest:first}}},{taskId:'t',stage:'analysis',planVersion:2,checkpoint:{template:{manifest:second}}}];
 assert.equal(normalizeWebRender({taskId:'t',basePlanVersion:1,otherRequirements:'',dataList:[scene]},runs).dataList[0].directing!.speechTurns[0].speakerId,'向导');
 assert.throws(()=>normalizeWebRender({taskId:'t',basePlanVersion:2,otherRequirements:'',dataList:[scene]},runs),/当前模板/);
});
