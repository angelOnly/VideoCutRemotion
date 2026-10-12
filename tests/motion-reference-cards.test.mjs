/** 以下构造数据测试验证读取合同，不能评估模型语义相关性；真实库测试另列。 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync,mkdirSync,symlinkSync} from 'node:fs';
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
test('分页完整覆盖原始记录，既不重复也不遗漏',()=>fixture(({path})=>{
 const l=loadCards(path);let off=0,all=[];do{const p=selectCards(l,{offset:off,limit:20});all.push(...p.cards.map(c=>c.case_number));off=p.next_offset;}while(off!==null);
 assert.equal(all.length,120);assert.equal(new Set(all).size,120);assert.deepEqual(all,Array.from({length:120},(_,i)=>i+1));
}));
test('没有题材关键词的案例仍出现在完整卡片中',()=>fixture(({path})=>{
 const p=selectCards(loadCards(path),{offset:40,limit:20}); assert.ok(p.cards.some(c=>c.case_number===60));assert.ok(!('score' in p.cards[19]));
}));
test('按编号读取保留请求顺序与原文',()=>fixture(({path,cases})=>{
 const r=selectCards(loadCards(path),{ids:[60,12]});assert.deepEqual(r.cards.map(c=>c.case_number),[60,12]);assert.equal(r.cards[0].scenario,cases[59].scenario);assert.ok(!('exhausted'in r));
}));
test('未知和重复编号明确失败',()=>fixture(({path})=>{const l=loadCards(path);assert.throws(()=>selectCards(l,{ids:[121]}));assert.throws(()=>selectCards(l,{ids:[1,1]}));}));
test('末页数量与结束游标明确',()=>fixture(({path})=>{const l=loadCards(path);const p=selectCards(l,{offset:20,limit:20});assert.equal(p.returned,3);assert.equal(p.exhausted,true);assert.equal(p.next_offset,null);},23));
test('空索引返回明确结束状态',()=>fixture(({path})=>{const p=selectCards(loadCards(path));assert.equal(p.returned,0);assert.equal(p.next_offset,null);},0));
test('拒绝无效分页参数',()=>fixture(({path})=>{const l=loadCards(path);for(const opt of [{offset:-1},{offset:121},{limit:0},{limit:51},{limit:1.5}])assert.throws(()=>selectCards(l,opt));}));
test('拒绝重复身份与数量不一致',()=>fixture(({path,cases})=>{writeFileSync(path,JSON.stringify({count:120,cases:[cases[0]]}));assert.throws(()=>loadCards(path));writeFileSync(path,JSON.stringify({cases:[cases[0],cases[0]]}));assert.throws(()=>loadCards(path));}));
test('拒绝损坏 JSON 与不安全路径',()=>fixture(({path,cases})=>{writeFileSync(path,'{broken');assert.throws(()=>loadCards(path));for(const bad of ['../secret','/root/secret','C:\\secret','http://example.com/x']){writeFileSync(path,JSON.stringify({cases:[{...cases[0],media:bad}]}));assert.throws(()=>loadCards(path));}}));
test('拒绝超出时长的源范围',()=>fixture(({path,cases})=>{writeFileSync(path,JSON.stringify({cases:[{...cases[0],recommended_segments:[{start:14,end:16}]}]}));assert.throws(()=>loadCards(path));}));
test('读取不改变索引，哈希随索引内容变化',()=>fixture(({path,cases})=>{const before=readFileSync(path);const a=loadCards(path);selectCards(a);assert.deepEqual(readFileSync(path),before);cases[0].scenario='不同的描述';writeFileSync(path,JSON.stringify({count:120,cases}));assert.notEqual(loadCards(path).catalogue_sha256,a.catalogue_sha256);}));
test('命令行返回 JSON，拒绝不存在的语义参数',()=>fixture(({path})=>{const ok=spawnSync(process.execPath,[script,'--catalogue',path,'--ids','012,060'],{encoding:'utf8'});assert.equal(ok.status,0,ok.stderr);assert.equal(JSON.parse(ok.stdout).returned,2);for(const argv of [['--query','票据'],['--semantic','true'],['--ids','1','--offset','0']]){const bad=spawnSync(process.execPath,[script,'--catalogue',path,...argv],{encoding:'utf8'});assert.notEqual(bad.status,0);}}));

test('真实库完整分页逐字段保真，读取不修改唯一索引',()=>{
 const path=fileURLToPath(new URL('../references/motion-cases/skillry/case-catalogue.json',import.meta.url));
 const before=readFileSync(path);
 const source=JSON.parse(before.toString('utf8'));
 const loaded=loadCards(path);
 const cards=[];
 let offset=0;
 do {
  const page=selectCards(loaded,{offset,limit:17});
  assert.equal(page.catalogue_sha256,loaded.catalogue_sha256);
  cards.push(...page.cards);
  offset=page.next_offset;
 } while(offset!==null);
 assert.equal(cards.length,source.cases.length);
 assert.deepEqual(cards.map(c=>c.case_number),source.cases.map(c=>c.case_number));
 for(let i=0;i<cards.length;i++) {
  for(const [key,value] of Object.entries(cards[i])) assert.deepEqual(value,source.cases[i][key]);
  for(const key of ['title','scenario','materials','methods','art','material_requirements','transfer_cost','analysis','media','recommended_segments']) {
   assert.deepEqual(cards[i][key],source.cases[i][key]);
  }
  assert.ok(!Object.hasOwn(cards[i],'score'));
 }
 assert.deepEqual(readFileSync(path),before);
});

test('默认索引从脚本位置定位，不依赖当前工作目录',()=>fixture(({dir})=>{
 const result=spawnSync(process.execPath,[script,'--ids','012,060'],{cwd:dir,encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 assert.deepEqual(JSON.parse(result.stdout).cards.map(c=>c.case_number),[12,60]);
}));

test('损坏记录给出可定位错误，UTF-8 BOM 可读但非法字节拒绝',()=>fixture(({path,cases})=>{
 writeFileSync(path,'\uFEFF'+JSON.stringify({cases:[cases[0]]}));
 assert.equal(loadCards(path).total,1);
 writeFileSync(path,Buffer.concat([Buffer.from('{"cases":[],"note":"'),Buffer.from([0xff]),Buffer.from('"}')]));
 assert.throws(()=>loadCards(path),/UTF-8 JSON/);
 for(const record of [null,[],{}, {cases:[{...cases[0],recommended_segments:[null]}]},
  {cases:[{...cases[0],duration:'15'}]}, {cases:[{...cases[0],material_requirements:[]}]},
  {cases:[{...cases[0],methods:[1]}]}]) {
  writeFileSync(path,JSON.stringify(record));
  assert.throws(()=>loadCards(path),/索引必须|范围无效|时长|字段无效/);
 }
}));

test('目录链接不能把媒体入口指向索引根目录外',()=>fixture(({dir,cases})=>{
 const root=join(dir,'library');
 const outside=join(dir,'outside');
 mkdirSync(root);mkdirSync(outside);
 writeFileSync(join(outside,'video.mp4'),'测试数据');
 symlinkSync(outside,join(root,'linked'),process.platform==='win32'?'junction':'dir');
 const path=join(root,'case-catalogue.json');
 for(const media of ['linked/video.mp4','linked/not-downloaded.mp4']) {
  writeFileSync(path,JSON.stringify({cases:[{...cases[0],media}]}));
  assert.throws(()=>loadCards(path),/符号链接超出索引目录/);
 }
}));

test('函数与命令行都拒绝混合查找方式和不完整参数，失败不输出半份 JSON',()=>fixture(({path})=>{
 assert.throws(()=>selectCards(loadCards(path),{ids:[1],offset:0}),/不能同时/);
 for(const argv of [['--limit'],['--limit','2','--limit','3'],['--offset','1.5'],['--ids',''],
  ['--ids','1,1'],['--ids','999'],['--ids','1','--limit','2']]) {
  const result=spawnSync(process.execPath,[script,'--catalogue',path,...argv],{encoding:'utf8'});
  assert.equal(result.status,1);
  assert.equal(result.stdout,'');
  assert.match(result.stderr,/read-case-cards:/);
 }
}));
