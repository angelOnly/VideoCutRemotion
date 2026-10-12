/** Tests use generated fixtures, not the user's 120 videos. They do not evaluate semantic relevance. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {loadCards,selectCards} from '../references/motion-cases/skillry/tools/read-case-cards.mjs';
const script=fileURLToPath(new URL('../references/motion-cases/skillry/tools/read-case-cards.mjs',import.meta.url));
function fixture(fn,n=120) {
 const dir=mkdtempSync(join(tmpdir(),'vfc-cards-'));
 const path=join(dir,'case-catalogue.json');
 const cases=Array.from({length:n},(_,i)=>({case_number:i+1,slug:`case-${i+1}`,title:`候选${i+1}`,
  scenario:i===59?'更换输入时同一容器保留结果':'观察一个具体变化',materials:['插画'],methods:['累积'],art:['轻线条'],
  analysis:`cases/case-${i+1}/analysis.md`,media:`cases/case-${i+1}/video.mp4`,duration:15,
  recommended_segments:[{start:10,end:15,reason:'关键过程'}]}));
 writeFileSync(path,JSON.stringify({count:n,cases}));
 try {fn({dir,path,cases});} finally {rmSync(dir,{recursive:true,force:true});}
}
test('pagination covers all source records exactly once',()=>fixture(({path})=>{
 const l=loadCards(path);let off=0,all=[];do{const p=selectCards(l,{offset:off,limit:20});all.push(...p.cards.map(c=>c.case_number));off=p.next_offset;}while(off!==null);
 assert.equal(all.length,120);assert.equal(new Set(all).size,120);assert.deepEqual(all,Array.from({length:120},(_,i)=>i+1));
}));
test('does not exclude records for lack of a topic keyword',()=>fixture(({path})=>{
 const p=selectCards(loadCards(path),{offset:40,limit:20}); assert.ok(p.cards.some(c=>c.case_number===60));assert.ok(!('score' in p.cards[19]));
}));
test('exact ID lookup keeps requested order and source text',()=>fixture(({path,cases})=>{
 const r=selectCards(loadCards(path),{ids:[60,12]});assert.deepEqual(r.cards.map(c=>c.case_number),[60,12]);assert.equal(r.cards[0].scenario,cases[59].scenario);assert.ok(!('exhausted'in r));
}));
test('unknown and duplicate IDs fail',()=>fixture(({path})=>{const l=loadCards(path);assert.throws(()=>selectCards(l,{ids:[121]}));assert.throws(()=>selectCards(l,{ids:[1,1]}));}));
test('end page and nonmultiple page lengths are explicit',()=>fixture(({path})=>{const l=loadCards(path);const p=selectCards(l,{offset:20,limit:20});assert.equal(p.returned,3);assert.equal(p.exhausted,true);assert.equal(p.next_offset,null);},23));
test('empty catalogue is supported',()=>fixture(({path})=>{const p=selectCards(loadCards(path));assert.equal(p.returned,0);assert.equal(p.next_offset,null);},0));
test('invalid pagination rejects',()=>fixture(({path})=>{const l=loadCards(path);for(const opt of [{offset:-1},{offset:121},{limit:0},{limit:51},{limit:1.5}])assert.throws(()=>selectCards(l,opt));}));
test('duplicate identifiers and count mismatch reject',()=>fixture(({path,cases})=>{writeFileSync(path,JSON.stringify({count:120,cases:[cases[0]]}));assert.throws(()=>loadCards(path));writeFileSync(path,JSON.stringify({cases:[cases[0],cases[0]]}));assert.throws(()=>loadCards(path));}));
test('malformed JSON and unsafe paths reject',()=>fixture(({path,cases})=>{writeFileSync(path,'{broken');assert.throws(()=>loadCards(path));for(const bad of ['../secret','/root/secret','C:\\secret','http://example.com/x']){writeFileSync(path,JSON.stringify({cases:[{...cases[0],media:bad}]}));assert.throws(()=>loadCards(path));}}));
test('out of bounds source segments reject',()=>fixture(({path,cases})=>{writeFileSync(path,JSON.stringify({cases:[{...cases[0],recommended_segments:[{start:14,end:16}]}]}));assert.throws(()=>loadCards(path));}));
test('catalogue bytes unchanged and hash reflects changes',()=>fixture(({path,cases})=>{const before=readFileSync(path);const a=loadCards(path);selectCards(a);assert.deepEqual(readFileSync(path),before);cases[0].scenario='不同的描述';writeFileSync(path,JSON.stringify({count:120,cases}));assert.notEqual(loadCards(path).catalogue_sha256,a.catalogue_sha256);}));
test('CLI returns JSON and rejects invented query/semantic flags',()=>fixture(({path})=>{const ok=spawnSync(process.execPath,[script,'--catalogue',path,'--ids','012,060'],{encoding:'utf8'});assert.equal(ok.status,0,ok.stderr);assert.equal(JSON.parse(ok.stdout).returned,2);for(const argv of [['--query','票据'],['--semantic','true'],['--ids','1','--offset','0']]){const bad=spawnSync(process.execPath,[script,'--catalogue',path,...argv],{encoding:'utf8'});assert.notEqual(bad.status,0);}}));
