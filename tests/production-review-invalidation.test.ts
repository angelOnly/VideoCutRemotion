import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {compareReviewSnapshots,snapshotFiles,type ReviewSnapshot} from '../packages/production-service/src/review-invalidation.js';

function snapshot():ReviewSnapshot{return {sourceDigest:'before',timelineRef:'timeline.json',files:{'timeline.json':'timeline','renderer/Scene.tsx':'code','renderer/public/a.wav':'audio-a','renderer/public/b.wav':'audio-b'},timeline:{fps:30,totalFrames:60,scenes:[0,1].map(i=>({id:`s${i}`,from:i*30,frames:30,utterances:[{id:`u${i}`,src:`${i?'b':'a'}.wav`,startFrame:0,endFrameExclusive:30}],captions:[{text:'原字幕',startFrame:0,endFrameExclusive:30,utteranceId:`u${i}`}],graphic:{value:i}}))}};}
function change(update:(after:ReviewSnapshot)=>void){const before=snapshot(),after=structuredClone(before);after.sourceDigest='after';update(after);return compareReviewSnapshots(before,after);}
test('差异只报告字段事实，不按字幕、音频或源码文件名决定复查目的',()=>{
 const caption=change(a=>{a.timeline.scenes[0].captions[0].text='新\n字幕';});
 assert.deepEqual(caption,{changedFiles:[],changedScenes:[{sceneId:'s0',fields:['captions'],kind:'changed'}],changedTimelineFields:[]});
 const shared=change(a=>{a.files['renderer/Scene.tsx']='new-code';a.files['renderer/public/a.wav']='new-sound';a.timeline.fps=25;});
 assert.deepEqual(shared.changedFiles,['renderer/Scene.tsx','renderer/public/a.wav']);assert.deepEqual(shared.changedScenes,[]);assert.deepEqual(shared.changedTimelineFields,['fps']);assert.ok(!JSON.stringify(shared).includes('checkIds'));
 const added=change(a=>{a.timeline.scenes.shift();a.timeline.scenes.push({id:'s2',frames:30});});
 assert.deepEqual(added.changedScenes.map(s=>[s.sceneId,s.kind]),[['s0','removed'],['s2','added']]);assert.deepEqual(added.changedTimelineFields,['sceneOrder']);
 const stable=snapshot();assert.deepEqual(compareReviewSnapshots(stable,structuredClone(stable)),{changedFiles:[],changedScenes:[],changedTimelineFields:[]});
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
