import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {compareReviewSnapshots,snapshotFiles,type ReviewSnapshot} from '../packages/production-service/src/review-invalidation.js';

function snapshot():ReviewSnapshot{return {sourceDigest:'before',timelineRef:'timeline.json',files:{'timeline.json':'timeline','renderer/Scene.tsx':'code','renderer/public/a.wav':'audio-a','renderer/public/b.wav':'audio-b'},timeline:{fps:30,totalFrames:60,scenes:[0,1].map(i=>({id:`s${i}`,from:i*30,frames:30,utterances:[{id:`u${i}`,src:`${i?'b':'a'}.wav`,startFrame:0,endFrameExclusive:30}],captions:[{text:'原字幕',startFrame:0,endFrameExclusive:30,utteranceId:`u${i}`}],graphic:{value:i}}))}};}
function change(update:(after:ReviewSnapshot)=>void){const before=snapshot(),after=structuredClone(before);after.sourceDigest='after';update(after);return compareReviewSnapshots(before,after);}
const checks=(items:ReturnType<typeof change>,scene:string)=>new Set(items.filter(i=>i.sceneIds.includes(scene)).flatMap(i=>i.checkIds));

test('字幕语义改变保守扩大章节，断行与换卡时间按落点失效',()=>{
 const text=change(after=>{after.timeline.scenes[0].captions[0].text='新字幕';});
 assert.ok(checks(text,'s0').has('visual-layout'));assert.ok(text[0].chapterWide);assert.equal(checks(text,'s1').size,0);
 const newline=change(after=>{after.timeline.scenes[0].captions[0].text='原\n字幕';});assert.deepEqual([...checks(newline,'s0')].sort(),['caption-layout','caption-reading']);assert.equal(newline[0].chapterWide,false);assert.deepEqual(newline[0].frameRanges,[{fromFrame:0,toFrame:30}]);
 const timing=change(after=>{after.timeline.scenes[0].captions[0].endFrameExclusive=29;});
 assert.deepEqual([...checks(timing,'s0')].sort(),['av-sync','caption-layout','caption-reading','continuity']);assert.equal(checks(timing,'s1').size,0);
});

test('局部图形只影响当前场景视觉，实际配音字节按真实引用定位',()=>{
 const graphic=change(after=>{after.timeline.scenes[0].graphic.value=8;});
 assert.ok(checks(graphic,'s0').has('motion'));assert.equal(checks(graphic,'s0').has('audio'),false);assert.equal(checks(graphic,'s1').size,0);
 const sound=change(after=>{after.files['renderer/public/a.wav']='new-audio';});
 assert.deepEqual([...checks(sound,'s0')].sort(),['audio','av-sync','caption-reading','continuity']);assert.equal(checks(sound,'s1').size,0);
});

test('句段摆放和全局时序扩大对应检查，未知共享源码保守扩大视觉',()=>{
 const speech=change(after=>{after.timeline.scenes[0].utterances[0].endFrameExclusive=29;});
 assert.ok(checks(speech,'s0').has('audio'));assert.ok(checks(speech,'s0').has('av-sync'));assert.equal(checks(speech,'s1').size,0);
 const global=change(after=>{after.timeline.fps=25;});
 for(const scene of ['s0','s1']){assert.ok(checks(global,scene).has('audio'));assert.ok(checks(global,scene).has('motion'));}
 const unknown=change(after=>{after.files['renderer/Scene.tsx']='unexplained-new-code';});
 for(const scene of ['s0','s1']){assert.ok(checks(unknown,scene).has('motion'));assert.equal(checks(unknown,scene).has('audio'),false);}
});

test('共享字幕规则、跨章关系及无可靠归属的声音不能缩小为局部',()=>{
 const style=change(after=>{after.timeline.captionStyle={fontSize:40};});
 const bridge=change(after=>{after.timeline.bridges=[{from:'s0',to:'s1'}];});
 const audio=change(after=>{after.files['renderer/public/background.wav']='new-track';});
 for(const result of [style,bridge,audio])for(const scene of ['s0','s1'])assert.ok(checks(result,scene).has('continuity'));
 for(const scene of ['s0','s1'])assert.ok(checks(audio,scene).has('audio'));
 const stable=snapshot();assert.deepEqual(compareReviewSnapshots(stable,structuredClone(stable)),[]);
});

test('全局字体真实字节变化保留独立声音；前段时长改变覆盖后续全局对齐',()=>{
 const font=change(after=>{after.files['renderer/public/fonts/chinese.woff2']='changed-font';});
 for(const scene of ['s0','s1']){assert.ok(checks(font,scene).has('caption-layout'));assert.ok(checks(font,scene).has('caption-reading'));assert.equal(checks(font,scene).has('audio'),false);}
 const duration=change(after=>{after.timeline.totalFrames=61;after.timeline.scenes[0].frames=31;after.timeline.scenes[0].utterances[0].endFrameExclusive=31;after.timeline.scenes[1].from=31;});
 for(const scene of ['s0','s1'])for(const required of ['audio','av-sync','caption-reading','continuity'])assert.ok(checks(duration,scene).has(required));
});

test('快照摘要读取真实文件，忽略依赖缓存且拒绝符号链接',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'review-files-'));
 try{
  await fs.writeFile(join(root,'timeline.json'),'{}');await fs.mkdir(join(root,'node_modules'));await fs.writeFile(join(root,'node_modules','ignored'),'依赖');
  const first=await snapshotFiles(root);assert.deepEqual(Object.keys(first),['timeline.json']);
  await fs.writeFile(join(root,'timeline.json'),'{"changed":true}');assert.notEqual((await snapshotFiles(root))['timeline.json'],first['timeline.json']);
  await fs.symlink(join(root,'timeline.json'),join(root,'linked.json'));await assert.rejects(snapshotFiles(root),/链接/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
