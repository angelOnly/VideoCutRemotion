import test from 'node:test';
import assert from 'node:assert/strict';
import {analysisRequestSchema,analysisResultSchema,sceneSchema} from '../packages/production-service/src/contracts.js';
import {parseSceneScript} from '../packages/production-service/src/scene-script.js';
import {speechBindings} from '../packages/production-service/src/scene-speech.js';
import {validateProductionTimeline} from '../packages/production-service/src/production-timeline.js';
import {normalizeWebAnalysis,normalizeWebRender} from '../packages/production-service/src/web-contract.js';
import {ProductionRepository} from '../packages/production-service/src/repository.js';

const request={taskId:'test',content:'【室长 亮相】（室长出镜）今天拆浩欧博。',otherRequirements:'',plugin:{customTemplateId:'finance'}};
const result=()=>({taskId:'test',runId:'00000000-0000-4000-8000-000000000001',inputDigest:'test',context:'采用室长台词及出镜安排',dataList:[{id:'s1',content:'【室长】【画面：室长出镜】今天拆浩欧博。',dur:3,durationSource:'estimated'}]});

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
 const script='【财小策】收入（含税）1.2亿。\n【室长】同比增长😀20%。【画面：展示收入图】';
 const scene=parseSceneScript({id:'s',content:script});assert.equal(scene.submittedContent,script);assert.equal(scene.content,'收入（含税）1.2亿。\n同比增长😀20%。');
 assert.deepEqual(scene.directing!.speechTurns.map(t=>[t.speakerId,scene.content.slice(t.start,t.end)]),[['caixiaoce','收入（含税）1.2亿。\n'],['shizhang','同比增长😀20%。']]);
 assert.deepEqual(scene.directing!.visualDirections,['展示收入图']);
 assert.deepEqual(parseSceneScript({id:'s',content:'  普通（括号）正文。\n'}),{id:'s',content:'  普通（括号）正文。\n'});
});
test('标签改人、拆并及重排从当前文本重新计算，无口播必须明确且不掩盖台词',()=>{
 const make=(content:string)=>parseSceneScript({id:'s',content});
 const a=make('【室长】新句。'),b=make('【财小策】另一句。');
 const merged=make(b.submittedContent!+a.submittedContent!);assert.deepEqual(merged.directing!.speechTurns.map(t=>t.speakerId),['caixiaoce','shizhang']);
 assert.equal(make('【室长】新句。').directing!.speechTurns[0].end,3);
 const visual=make('【章节：企业概况】【无口播：2.5秒】【画面：展示图表】');assert.equal(visual.content,'');assert.equal(visual.directing!.durationSec,2.5);
 for(const content of ['【室长','【未知人物】台词。','【画面：图表】','【无口播：0秒】【画面：图表】','【无口播：3601秒】【画面：图表】','【无口播：2秒】','【无口播：2秒】【画面：图表】这是台词','【无口播：2秒】【无口播：3秒】【画面：图表】'])assert.throws(()=>make(content),content);
});
test('人物轮次范围完整且不能拆开字符，句段不得跨人或配错音色',()=>{
 const scene:any={id:'s',content:'甲。乙。',directing:{kind:'speech',speechTurns:[{id:'a',speakerId:'caixiaoce',start:0,end:2},{id:'b',speakerId:'shizhang',start:2,end:4}],visualDirections:[]}};
 const bound=speechBindings(scene,[{id:'u1',text:'甲。',voiceRef:'finance.female'},{id:'u2',text:'乙。',voiceRef:'finance.male'}],false,{speakerBindings:{caixiaoce:{speaker:'female-host',voiceRef:'finance.female'},shizhang:{speaker:'male-chief',voiceRef:'finance.male'}}});assert.equal(bound[1]?.speaker,'male-chief');assert.equal(bound[0]?.turnId,'a');
 assert.throws(()=>speechBindings(scene,[{id:'u',text:'甲。乙。',voiceRef:'finance.female'}]),/跨越/);
 assert.throws(()=>speechBindings(scene,[{id:'u1',text:'甲。',voiceRef:'finance.male'},{id:'u2',text:'乙。'}],false,{speakerBindings:{caixiaoce:{speaker:'female-host',voiceRef:'finance.female'},shizhang:{speaker:'male-chief',voiceRef:'finance.male'}}}),/音色/);
 scene.directing.speechTurns[1].start=3;assert.throws(()=>sceneSchema.parse(scene));
 scene.content='😀甲。';scene.directing.speechTurns[0].end=1;scene.directing.speechTurns[1].start=1;assert.throws(()=>sceneSchema.parse(scene));
});
test('现有网页提交无需新增字段，当前改句和标签持久化，旧人物及旧镜头不恢复',()=>{
 const repo=new ProductionRepository(':memory:');try{
 const a=repo.accept('a','analysis',request),claimed=repo.claim()!;repo.finish(a.runId,claimed.token,'succeeded',result());
 const input={taskId:'test',dataList:[{id:'new',content:'【财小策】网页新增台词。',dur:8,extraData:{keywordList:[]}}]};
 const normalized=normalizeWebRender(input,repo.list('a','test'));assert.equal(normalized.basePlanVersion,a.planVersion);assert.equal(normalized.otherRequirements,'');
 assert.equal(normalized.dataList.length,1);assert.equal(normalized.dataList[0].id,'new');assert.equal(normalized.dataList[0].content,'网页新增台词。');assert.equal(normalized.dataList[0].directing!.speechTurns[0].speakerId,'caixiaoce');
 const r=repo.accept('a','render',normalized);assert.deepEqual(r.request,JSON.parse(JSON.stringify(normalized)));assert.equal(repo.accept('a','render',normalized).runId,r.runId);
 const changed=normalizeWebRender({...input,dataList:[{id:'new',content:'【室长】网页新增台词。'}]},repo.list('a','test'));assert.notEqual(repo.accept('a','render',changed).runId,r.runId);
 const plain=normalizeWebRender({...input,dataList:[{id:'new',content:'网页新增台词。'}]},repo.list('a','test'));assert.equal(plain.dataList[0].directing,undefined);
 repo.accept('a','analysis',{...request,otherRequirements:'新版'});
 assert.throws(()=>normalizeWebRender(input,repo.list('a','test')),/最新 Analysis/);
 }finally{repo.close();}
});
test('无口播场景连续切分，片头公司依据必须来自当前稿，口播缺音频仍失败',()=>{
 const visual:any={id:'v',content:'',directing:{kind:'visual',speechTurns:[],visualDirections:['展示图表'],durationSec:2}};
 const timeline:any={fps:30,totalFrames:60,scenes:[{id:'v',from:0,frames:60,utterances:[],captions:[],intro:{src:'intro.mp4',fromFrame:0,frames:30,companyName:null}}]};
 assert.deepEqual(validateProductionTimeline(timeline,[visual],30).ranges,[{id:'v',fromFrame:0,toFrame:60}]);
 assert.throws(()=>validateProductionTimeline(timeline,[{id:'v',content:'正文'}],30));
 timeline.scenes[0].intro.companyName='旧公司';timeline.scenes[0].intro.companyEvidence={sceneId:'v',field:'content',start:0,end:3};assert.throws(()=>validateProductionTimeline(timeline,[visual],30),/当前采用/);
 visual.directing.chapter='新公司';timeline.scenes[0].intro.companyName='新公司';timeline.scenes[0].intro.companyEvidence={sceneId:'v',field:'chapter',start:0,end:3};validateProductionTimeline(timeline,[visual],30);
 visual.directing.chapter='换公司';assert.throws(()=>validateProductionTimeline(timeline,[visual],30),/当前采用/);
 delete timeline.scenes[0].intro;timeline.scenes[0].frames=59;assert.throws(()=>validateProductionTimeline(timeline,[visual],30));
 assert.throws(()=>sceneSchema.parse({...visual,content:'不能掩盖口播'}));
});

test('人物绑定来自模板，普通人物不按财经音色猜测，明确声明才能约束',()=>{
 const scene:any={id:'custom',content:'原句',directing:{kind:'speech',speechTurns:[{id:'turn',speakerId:'caixiaoce',start:0,end:2}],visualDirections:[]}};
 const segment={id:'voice',text:'原句',voiceRef:'custom.voice'};
 assert.throws(()=>speechBindings(scene,[segment]),/未知模板人物/);
 assert.equal(speechBindings(scene,[segment],false,{speakerBindings:{caixiaoce:{speaker:'custom.actor',voiceRef:'custom.voice'}}})[0]?.speaker,'custom.actor');
 scene.directing.speechTurns[0].speakerId=null;
 assert.deepEqual(speechBindings(scene,[{...segment,voiceRef:'finance.female'}]),[{turnId:'turn'}]);
});
