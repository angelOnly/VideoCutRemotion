import {build} from 'esbuild';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(process.argv[2]);
const {readFile,stat}=await import('node:fs/promises');
const manifest=JSON.parse(await readFile(resolve(root,'renderer/renderer-manifest.json'),'utf8'));
if(manifest.timelineContract!=='sentence-timeline/1'||manifest.timelineDataRef!=='timeline.json')throw new Error('模板缺少单一 JSON 时间线合同');
if(manifest.timelineValidator!=='src/validateTimeline.ts')throw new Error('模板未声明可提前执行的同源校验器');
const source=await readFile(resolve(root,'renderer',manifest.timelineModule),'utf8');
if(!source.includes("import timelineData from '../timeline.json'")||!/export const timeline: FinanceTimeline = timelineData as FinanceTimeline;/.test(source))throw new Error('渲染入口未使用唯一时间线');
const example=JSON.parse(await readFile(resolve(root,'renderer',manifest.timelineDataRef),'utf8'));
// 随包固定素材必须使用实际 public 地址；动态配音示例由正式装配替换。
async function assertTemplateReferences(value){
  if(!value||typeof value!=='object')return;
  for(const [key,item] of Object.entries(value)){
    if(key==='src'&&typeof item==='string'){
      if(item.startsWith('speech/'))continue;
      if(!item.startsWith('template-assets/'))throw new Error(`模板素材地址没有从 public 起算：${item}`);
      if(!(await stat(resolve(root,'renderer/public',item))).isFile())throw new Error(`模板固定素材缺失：${item}`);
    }else await assertTemplateReferences(item);
  }
}
await assertTemplateReferences(example);
await assertTemplateReferences([
  {src:'template-assets/assets/video/intro/financial-intro-portrait-sfx-v1.mov'},
  {src:'template-assets/assets/audio/bgm/immersed.mp3'},
  {src:'template-assets/assets/images/brand/logo-dark.png'},
  {src:'template-assets/assets/images/hosts/female-host.png'},
  {src:'template-assets/assets/images/hosts/male-chief.png'},
]);
for(const name of ['FinancialDialogue.tsx','FinancialIntros.tsx']){
  const content=await readFile(resolve(root,'renderer/src',name),'utf8');
  if(content.includes('const asset =')||content.includes('staticFile(`template-assets/${path}`)'))throw new Error(`${name} 仍在播放时补素材目录`);
}
console.log('统一 public 素材地址及随包固定素材检查通过');
// 栏目规则从生成包加载，验证换题检查确实随模板交付。
const {pathToFileURL}=await import('node:url');
const {verifyEpisode}=await import(pathToFileURL(resolve(root,'renderer/scripts/verify-episode.mjs')).href);

// 编译本地模块及新增示例，外部依赖由正式运行环境提供。
await build({entryPoints:[resolve(root,'renderer/src/index.ts'),resolve(root,'renderer/src/safe-visuals.tsx')],bundle:true,write:false,outdir:'unused',platform:'browser',packages:'external',jsx:'automatic',nodePaths:[resolve(dirname(fileURLToPath(import.meta.url)),'../node_modules')]});
console.log('模板源码编译通过');
// 状态退出必须真正卸载整组对象，保留指定时钟；不能靠隐去标题留下旧图表。
const primitives=await build({entryPoints:[resolve(root,'renderer/src/safe-visuals.tsx')],bundle:true,write:false,platform:'node',format:'cjs',packages:'external',jsx:'automatic'});


// 对生成后的真实校验器跑边界用例，未通过就不允许打包ZIP。
const {createRequire}=await import('node:module');
const assert=(await import('node:assert/strict')).default;
const require=createRequire(import.meta.url);
const primitiveMod={exports:{}};new Function('require','module','exports',primitives.outputFiles[0].text)(require,primitiveMod,primitiveMod.exports);
const {VisualState,isVisualFrame}=primitiveMod.exports;
for(const frame of [9,20])assert.equal(VisualState({frame,fromFrame:10,toFrame:20,children:()=>{throw new Error('边界外不能挂载旧画面');}}),null);
let local;VisualState({frame:19,fromFrame:10,toFrame:20,children:value=>{local=value;return null;}});assert.equal(local,9);
assert.equal(isVisualFrame(20,20,30),true);assert.throws(()=>isVisualFrame(0,5,5),/半开/);

assert.deepEqual(Object.keys(manifest.speakerBindings),['财小策','室长']);
const confirmed=[{id:'s',content:'今天拆新公司。',directing:{chapter:'新公司'}}];
const episode={scenes:[{id:'s',intro:{companyName:'新公司',companyEvidence:{sceneId:'s',field:'content',start:3,end:6}}}]};
verifyEpisode(episode,confirmed);
episode.scenes[0].intro.companyName='旧公司';assert.throws(()=>verifyEpisode(episode,confirmed),/当前确认/);
episode.scenes[0].intro.companyName='新公司';episode.scenes[0].intro.companyEvidence={sceneId:'s',field:'chapter',start:0,end:3};verifyEpisode(episode,confirmed);
confirmed[0].directing.chapter='换公司';assert.throws(()=>verifyEpisode(episode,confirmed),/当前确认/);
episode.scenes[0].intro.companyName=null;verifyEpisode(episode,confirmed);
console.log('模板人物表与本期公司名来源检查通过');
const compiled=await build({entryPoints:[resolve(root,'renderer/src/validateTimeline.ts')],bundle:true,write:false,platform:'node',format:'cjs',packages:'external'});
const mod={exports:{}};new Function('require','module','exports',compiled.outputFiles[0].text)(require,mod,mod.exports);
const {validateTimeline}=mod.exports;
validateTimeline(example);
const timing=await build({entryPoints:[resolve(root,'renderer/src/intro-timing.ts')],bundle:true,write:false,platform:'node',format:'cjs'});
const timingMod={exports:{}};new Function('module','exports',timing.outputFiles[0].text)(timingMod,timingMod.exports);
const {isIntroFrame}=timingMod.exports;
const make=()=>({width:1920,height:1080,fps:30,totalFrames:100,chapters:[{id:'c',from:0,endFrameExclusive:100,label:'测试',title:'标题',summary:'摘要',visualBlocks:[{id:'v',kind:'metric',startFrame:0,endFrameExclusive:100,props:{label:'数值',value:'90%',detail:'测试'}}]}],scenes:[{id:'s',from:0,frames:100,speaker:'male-chief',summary:'测试',intro:{fromFrame:20,frames:30,src:'test.mp4',muted:true},visualBlocks:[],captions:[],utterances:[]}]});
validateTimeline(make());
const scene=make().scenes[0];assert.equal(isIntroFrame(scene,19),false);assert.equal(isIntroFrame(scene,20),true);assert.equal(isIntroFrame(scene,49),true);assert.equal(isIntroFrame(scene,50),false);
for(const [from,to] of [[1,100],[0,99]]){const value=make();value.chapters[0].visualBlocks[0].startFrame=from;value.chapters[0].visualBlocks[0].endFrameExclusive=to;assert.throws(()=>validateTimeline(value),/图解覆盖/);}
const gap=make();gap.chapters[0].from=1;gap.chapters[0].visualBlocks[0].endFrameExclusive=99;assert.throws(()=>validateTimeline(gap),/章节覆盖/);
const missing=make();delete missing.scenes[0].intro.frames;assert.throws(()=>validateTimeline(missing),/实测/);
const overlap=make();overlap.scenes[0].chapter={frames:25};assert.throws(()=>validateTimeline(overlap),/重叠/);
console.log('片头首末帧、片头前后正文覆盖和转场冲突检查通过');

// 配音变长只改变所属范围，覆盖到末尾的图解随之延长；显式语义动作点保持原值。
const expanded=make();delete expanded.chapters[0].visualBlocks[0].endFrameExclusive;
expanded.scenes[0].frames=160;expanded.chapters[0].endFrameExclusive=160;expanded.totalFrames=160;
expanded.scenes[0].utterances=[{id:'late',text:'实测长配音',src:'speech/late.mp3',startFrame:50,endFrameExclusive:150}];
validateTimeline(expanded);
expanded.scenes[0].contentFrames=100;assert.throws(()=>validateTimeline(expanded),/contentFrames 已删除/);delete expanded.scenes[0].contentFrames;
const visualTiming=await build({entryPoints:[resolve(root,'renderer/src/visual-timing.ts')],bundle:true,write:false,platform:'node',format:'cjs'});
const visualTimingMod={exports:{}};new Function('module','exports',visualTiming.outputFiles[0].text)(visualTimingMod,visualTimingMod.exports);
const fixed={id:'fixed',kind:'trend',startFrame:20,endFrameExclusive:70,props:{revealFrame:11}};
const following={...fixed,id:'following'};delete following.endFrameExclusive;
const plans=[fixed,following],before=JSON.stringify(plans),resolved=visualTimingMod.exports.resolveVisualBlocks(plans,160);
assert.deepEqual(resolved.map(b=>[b.startFrame,b.endFrameExclusive,b.props.revealFrame]),[[20,70,11],[20,160,11]]);assert.equal(JSON.stringify(plans),before);
const outOfRange=make();outOfRange.chapters[0].visualBlocks[0].endFrameExclusive=101;assert.throws(()=>validateTimeline(outOfRange),/时间越界/);
const views=await build({entryPoints:[resolve(root,'renderer/src/VisualBlocks.tsx')],bundle:true,write:false,platform:'node',format:'cjs',packages:'external',jsx:'automatic'});
const viewsMod={exports:{}};new Function('require','module','exports',views.outputFiles[0].text)(require,viewsMod,viewsMod.exports);
const rendered=frame=>viewsMod.exports.VisualBlocks({blocks:[following],frames:160,frame,title:'实测章节',label:'测试'}).props.children[1].props.children;
assert.equal(rendered(159).length,1);assert.equal(rendered(160).length,0);
console.log('实测时长、缺省图解末端、显式动作点和旧声音窗拒绝检查通过');

const endingTiming=await build({entryPoints:[resolve(root,'renderer/src/ending-timing.ts')],bundle:true,write:false,platform:'node',format:'cjs'});
const endingTimingMod={exports:{}};new Function('module','exports',endingTiming.outputFiles[0].text)(endingTimingMod,endingTimingMod.exports);
const {closingHoldFrame}=endingTimingMod.exports;
const closing=make();delete closing.scenes[0].intro;delete closing.chapters[0].visualBlocks[0].endFrameExclusive;
closing.scenes[0].utterances=[{id:'body',text:'正文',src:'speech/body.mp3',startFrame:0,endFrameExclusive:70},{id:'closing',text:'结束语',src:'speech/closing.mp3',startFrame:70,endFrameExclusive:90}];
closing.ending={closingUtteranceIds:['closing'],narrationEndFrame:100,outro:{src:'template-assets/assets/video/outro/financial-intro-logo-sfx-v3.mov',frames:30,muted:true}};closing.totalFrames=130;
validateTimeline(closing);assert.equal(closingHoldFrame(closing),69);
closing.scenes[0].utterances[0].endFrameExclusive=80;Object.assign(closing.scenes[0].utterances[1],{startFrame:80,endFrameExclusive:110});closing.scenes[0].frames=120;closing.chapters[0].endFrameExclusive=120;closing.ending.narrationEndFrame=120;closing.totalFrames=150;
validateTimeline(closing);assert.equal(closingHoldFrame(closing),79);
closing.ending.holdFrame=69;assert.throws(()=>validateTimeline(closing),/holdFrame 已删除/);delete closing.ending.holdFrame;
const noClosing=structuredClone(closing);noClosing.ending.closingUtteranceIds=[];assert.equal(closingHoldFrame(noClosing),undefined);validateTimeline(noClosing);
const noBody=structuredClone(closing);noBody.scenes[0].utterances.shift();assert.throws(()=>validateTimeline(noBody),/结束语之前必须有正文/);
console.log('实测正文末帧派生结束语保持、无结束语及缺正文边界检查通过');

const actors=await build({entryPoints:[resolve(root,'renderer/src/CompanyTitleOverlay.tsx')],bundle:true,write:false,platform:'node',format:'cjs',packages:'external',jsx:'automatic'});
const actorMod={exports:{}};new Function('require','module','exports',actors.outputFiles[0].text)(require,actorMod,actorMod.exports);
const {activeSpeaker,CompanyTitleOverlay}=actorMod.exports;
const actorsScene={speaker:'male-chief',utterances:[{startFrame:10,endFrameExclusive:20,speaker:'female-host'},{startFrame:20,endFrameExclusive:30,speaker:'male-chief'}]};
assert.equal(activeSpeaker(actorsScene,9),'male-chief');assert.equal(activeSpeaker(actorsScene,10),'female-host');assert.equal(activeSpeaker(actorsScene,19),'female-host');assert.equal(activeSpeaker(actorsScene,20),'male-chief');assert.equal(activeSpeaker(actorsScene,30),'male-chief');assert.equal(CompanyTitleOverlay({name:null}),null);
const visual=make();visual.scenes[0].directing={kind:'visual',durationSec:100/30,visualDirections:['展示图表']};validateTimeline(visual);
visual.ending={closingUtteranceIds:[],narrationEndFrame:100,outro:{src:'outro.mp4',frames:30,muted:true}};visual.totalFrames=130;validateTimeline(visual);
visual.scenes[0].directing.durationSec=1;assert.throws(()=>validateTimeline(visual),/无口播/);
console.log('句段人物切换、空公司名和无口播独立片尾校验通过');

// 可选实际合成检查只在传入候选目录中生成夹具与静帧，不改生产工程。
if(process.argv.includes('--render-frames')){
  const {writeFile,mkdir,rm,readdir}=await import('node:fs/promises');
  const {bundle}=await import('@remotion/bundler');
  const {openBrowser,renderStill,selectComposition}=await import('@remotion/renderer');
  const frameRoot=resolve(root,'verification-frames'),entry=resolve(root,'renderer/verify-entry.tsx');await mkdir(frameRoot,{recursive:true});
  const fixture={...make(),totalFrames:120,chapters:make().chapters.map(c=>({...c,endFrameExclusive:120,visualBlocks:c.visualBlocks.map(v=>{const {endFrameExclusive,...plan}=v;return plan;})})),bgm:{src:'template-assets/assets/audio/bgm/immersed.mp3',volume:.01},scenes:[{...make().scenes[0],frames:120,summary:'人物切换验证',intro:{fromFrame:20,frames:67,src:'template-assets/assets/video/intro/financial-intro-portrait-sfx-v1.mov',muted:true,companyName:'浩欧博'},utterances:[{id:'a',text:'甲。',src:'',speaker:'female-host',startFrame:90,endFrameExclusive:95},{id:'b',text:'乙。',src:'',speaker:'male-chief',startFrame:95,endFrameExclusive:110}],captions:[]}]};
  // 本用例只观察画面，真实音频及 PCM 由服务集成测试独立覆盖。
  const fontFile=(await readdir(resolve(root,'renderer/public/fonts'))).find(f=>/^NotoSansSC.*\.(otf|ttf)$/.test(f));if(!fontFile)throw Error('候选缺少中文字体');
  const code=`import React from 'react';import {Composition,registerRoot,staticFile,delayRender,continueRender} from 'remotion';import {FinanceScene} from './src/FinancialDialogue';
const base=${JSON.stringify(fixture)};const h=delayRender('加载中文');const font=new FontFace('Noto Sans CJK SC',\`url(\${staticFile('fonts/${fontFile}')})\`);font.load().then(f=>{document.fonts.add(f);continueRender(h);});
const View=({companyName,bodyEnd})=>{const scene={...base.scenes[0],intro:{...base.scenes[0].intro,companyName},utterances:base.scenes[0].utterances.map(u=>({...u,src:'verification-silence.wav'}))};const timeline={...base,scenes:[scene]};if(bodyEnd){scene.utterances[0].endFrameExclusive=bodyEnd;Object.assign(scene.utterances[1],{startFrame:bodyEnd,endFrameExclusive:bodyEnd+10});timeline.ending={closingUtteranceIds:['b'],narrationEndFrame:120};}return <FinanceScene scene={scene} timeline={timeline}/>;};registerRoot(()=> <Composition id="Verify" component={View} width={1920} height={1080} fps={30} durationInFrames={120} defaultProps={{companyName:'浩欧博',bodyEnd:null}}/>);`;
  await writeFile(entry,code);
  // WAV 仅供截图夹具加载，绝不进入模板时间线或正式配音。
  const wav=Buffer.alloc(44+48000*2);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(48000,24);wav.writeUInt32LE(96000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
  const audio=resolve(root,'renderer/public/verification-silence.wav');await writeFile(audio,wav);
  let browser;try{
    const serveUrl=await bundle({entryPoint:entry,publicDir:resolve(root,'renderer/public'),webpackOverride:c=>({...c,resolve:{...c.resolve,modules:[resolve(dirname(fileURLToPath(import.meta.url)),'../node_modules'),'node_modules']}})});
    browser=await openBrowser('chrome',{browserExecutable:process.env.REMOTION_BROWSER_EXECUTABLE});const composition=await selectComposition({serveUrl,id:'Verify',puppeteerInstance:browser});
    const cases=[['before',19,'浩欧博'],['before-none',19,null],['start',20,'浩欧博'],['middle',50,'浩欧博'],['last',86,'浩欧博'],['after',87,'浩欧博'],['after-none',87,null],['none',50,null],['changed',50,'华正新材'],['long',50,'中国超长公司名称换行验证股份有限公司集团产业投资发展控股公司'],['female',92,null],['male',100,null],['body-95',94,null,95],['held-95',112,null,95],['body-105',104,null,105],['held-105',116,null,105]];
    for(const [name,frame,companyName,bodyEnd=null] of cases)await renderStill({serveUrl,composition:{...composition,props:{companyName,bodyEnd}},inputProps:{companyName,bodyEnd},frame,puppeteerInstance:browser,output:resolve(frameRoot,`${name}.png`),imageFormat:'png'});
    for(const name of ['none','changed','long'])assert.equal((await readFile(resolve(frameRoot,'middle.png'))).equals(await readFile(resolve(frameRoot,`${name}.png`))),false,`${name} 未实际改变画面`);
    // Chrome 渐变存在最多 2 级 RGB 抖动；比较解码像素，避免 PNG 字节差异误报。
    const {PNG}=await import('pngjs');
    for(const [first,second] of [['before','before-none'],['after','after-none'],['body-95','held-95'],['body-105','held-105']]){const a=PNG.sync.read(await readFile(resolve(frameRoot,`${first}.png`))),b=PNG.sync.read(await readFile(resolve(frameRoot,`${second}.png`)));let max=0;for(let i=0;i<a.data.length;i++)max=Math.max(max,Math.abs(a.data[i]-b.data[i]));assert.ok(max<=2,`${first}/${second} 边界或保持画面改变，最大通道差 ${max}`);}
    console.log('实际模板边界、换题、长名称与同镜换人静帧：'+frameRoot);
  }finally{await browser?.close({silent:true});await rm(entry,{force:true});await rm(audio,{force:true});}
}
