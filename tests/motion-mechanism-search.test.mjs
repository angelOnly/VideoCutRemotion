import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {queryMechanisms,understandQuery,connection} from '../references/motion-cases/skillry/mechanism-search.mjs';
import {taxonomy,validateRetrieval} from '../references/motion-cases/skillry/taxonomy.mjs';
import {encodeSelection,decodeSelection,restoreSelection,editSelection} from '../references/motion-cases/skillry/selection.mjs';
import {loadIndex,localFile} from '../references/motion-cases/skillry/tools/mechanisms.mjs';
import {readLibraryMechanism} from '../references/motion-cases/skillry/tools/library-store.mjs';
import {createMechanismBrowser,filterFields} from '../references/motion-cases/skillry/mechanism-filters.mjs';
const root=resolve('references/motion-cases/skillry'),index=loadIndex(root);

test('120个案例的全部资料具备统一分类，数量随正式目录变化',()=>{
  const catalogue=JSON.parse(readFileSync(join(root,'case-catalogue.json'),'utf8'));
  assert.equal(index.count,catalogue.cases.reduce((n,c)=>n+c.mechanism_ids.length,0));assert.equal(new Set(index.mechanisms.map(m=>m.case_number)).size,120);
  const categories=new Set();for(const m of index.mechanisms){validateRetrieval(m.retrieval,m.id);m.retrieval.categories.forEach(c=>categories.add(c));}
  assert.equal(categories.size,taxonomy.categories.length);
  assert.throws(()=>validateRetrieval({...index.mechanisms[0].retrieval,holds:['不知道']}),/词表/);
});
test('自然语言分阶段、同义词召回；否定不当正向词，同义词不重复加分',()=>{
  const phases=queryMechanisms(index,{stages:['依次填满网格','从圆形开口推近内部'],limit:20});
  assert.equal(phases.groups.length,2);assert.ok(phases.groups.every(g=>g.total>0));
  assert.ok(phases.groups[0].cards.some(m=>m.retrieval.actions.includes('填充')));
  assert.ok(queryMechanisms(index,{query:'划线',limit:50}).cards.every(m=>m.retrieval.actions.includes('描画')));
  assert.deepEqual(queryMechanisms(index,{query:'放大'}).cards.map(m=>[m.id,m.score]),queryMechanisms(index,{query:'放大 变大'}).cards.map(m=>[m.id,m.score]));
  const negative=understandQuery('不要旋转，依次填满');assert.ok(!negative.concepts.actions.includes('旋转'));assert.equal(negative.warnings.length,1);
  assert.equal(queryMechanisms(index,{query:'zxqv_unfindable_902384'}).total,0);
});
test('当前状态、保持和排除是硬筛选，不静默放宽',()=>{
  const specific=queryMechanisms(index,{query:'内部上滚',entry:['外框'],holds:['外框保持'],limit:5});
  assert.ok(specific.cards.some(m=>m.id==='037-m03'));
  assert.ok(specific.cards.some(m=>m.id==='049-m02'));
  assert.ok(queryMechanisms(index,{query:'纵向滚动',entry:['外框'],holds:['外框保持'],limit:5}).cards.some(m=>m.id==='043-m04'));
  const result=queryMechanisms(index,{query:'滚动',entry:['外框'],holds:['外框保持'],exclude_actions:['旋转'],limit:50});
  assert.ok(result.total>0);for(const m of result.cards){assert.ok(m.retrieval.entry.includes('外框'));assert.ok(m.retrieval.holds.includes('外框保持'));assert.ok(!m.retrieval.actions.includes('旋转'));}
  assert.throws(()=>queryMechanisms(index,{entry:['根本不存在']}),/未知/);
  assert.equal(queryMechanisms(index,{actions:['旋转'],exclude_actions:['旋转']}).total,0);
});

test('网页选项数量按其他组计算，有数量的替换选项一定有结果',()=>{
  const browse=createMechanismBrowser(index),state={categories:'建立与累积',actions:'回弹'};
  const expected=index.mechanisms.filter(m=>m.retrieval.categories.includes(state.categories)&&m.retrieval.actions.includes(state.actions));
  const result=browse(state);assert.equal(result.total,expected.length);assert.equal(result.facets.entry.counts['网格']??0,0);
  assert.ok(result.facets.actions.counts['描画']>0,'本组其他动作不能被当前回弹条件锁死');
  for(const selected of [state,{case:'5'},{entry:'外框',holds:'外框保持'}]){
    const view=browse(selected);
    for(const field of filterFields){
      assert.equal(browse({...selected,[field]:''}).total,view.facets[field].total);
      for(const [value,total] of Object.entries(view.facets[field].counts))assert.equal(browse({...selected,[field]:value}).total,total);
    }
  }
});

test('旧链接五项冲突提供最少解除方案，单项取消无效时不误导',()=>{
  const browse=createMechanismBrowser(index),state={categories:'建立与累积',actions:'回弹',entry:'网格',holds:'主体保持',case:'5'};
  const original={...state},view=browse(state);assert.equal(view.total,0);assert.deepEqual(state,original);
  for(const field of filterFields)assert.equal(browse({...state,[field]:''}).total,0);
  assert.ok(view.recovery.length>0);
  for(const choice of view.recovery){
    assert.equal(choice.remove.length,2);
    const next={...state};for(const field of choice.remove)delete next[field];
    assert.equal(browse(next).total,choice.total);assert.ok(choice.total>0);
  }
  assert.deepEqual(browse({categories:state.categories,entry:'网格',case:'5'}).cards.map(m=>m.id),['005-m07']);
});

test('关键词参与联动和恢复，计数覆盖全部分页，缓存不串查询',()=>{
  const browse=createMechanismBrowser(index),query='内部';
  assert.ok(browse({query}).total>50);
  assert.equal(browse({query}).total,queryMechanisms(index,{query}).total);
  const filtered=browse({query,entry:'外框'});
  assert.equal(filtered.total,queryMechanisms(index,{query,entry:['外框']}).total);
  assert.equal(filtered.facets.entry.total,browse({query}).total);
  const empty=browse({query:'zxqv_unfindable_902384',case:'5'});
  assert.deepEqual(empty.recovery,[{remove:['query'],total:7}]);
  assert.equal(browse({query}).total,queryMechanisms(index,{query}).total);
  assert.equal(browse({},1).cards.length,24);assert.equal(browse({case:'5'},20).page,0);
  assert.equal(browse({case:'5'},20).cards.length,7);
});
test('相似演法带差异，前后段带条件并区分方向',()=>{
  const similar=queryMechanisms(index,{similar_to:'007-m18'});assert.ok(similar.total>0);
  assert.ok(similar.cards.every(m=>m.id!=='007-m18'&&m.difference&&m.match_reasons.length));
  for(const mode of ['before','after']){
    const result=queryMechanisms(index,{[mode]:'060-m08'});assert.ok(result.total>0);
    for(const m of result.cards){assert.equal(m.connection[mode==='before'?'to':'from'],'060-m08');assert.equal(m.connection.continuous_verified,false);assert.ok(m.connection.gap);}
  }
  assert.throws(()=>queryMechanisms(index,{after:'060-m08',before:'060-m09'}),/一种/);
});
test('分页可遍历全部召回，读取指纹改变明确拒绝',()=>{
  const ids=[];let offset=0;do{const r=queryMechanisms(index,{offset,limit:50,source_sha256:index.source_sha256});ids.push(...r.cards.map(m=>m.id));offset=r.next_offset;}while(offset!==null);
  assert.deepEqual([...ids].sort(),index.mechanisms.map(m=>m.id).sort());assert.equal(new Set(ids).size,index.count);
  assert.throws(()=>queryMechanisms(index,{source_sha256:'0'.repeat(64)}),/变化/);
  assert.throws(()=>queryMechanisms(index,{ids:['999-m01']}),/未知/);
  assert.throws(()=>queryMechanisms(index,{ids:['001-m01'],query:'填充'}),/混用/);
});
test('完整段落能从内部动作找到，旧碎片编号不会指向新含义',()=>{
  for(const [query,id] of [['主矩形扩张回调后内部划线文字显出外围补点','002-m16'],['网格逐行填满','002-m17'],['横排累积前景下降内部补齐','002-m24']]){
    assert.ok(queryMechanisms(index,{query,limit:8}).cards.some(m=>m.id===id),query);
  }
  assert.throws(()=>readLibraryMechanism(root,{id:'002-m01',include_storyboard:false}),/未知|不存在/);
  const old=restoreSelection({v:1,source_sha256:'48eae58c4ed74896d27d54ee7b09613f8c415a06d23b9770021724e4f3d76c30',ids:['002-m01','002-m02','002-m03'],adopted:[]},index);
  assert.equal(old.stale,true);assert.deepEqual(old.unknown_ids,old.ids);
});
test('候选增删、排序、采用、链接恢复与过期未知项均可追踪',()=>{
  let selection={v:1,source_sha256:index.source_sha256,ids:['060-m08','060-m09'],adopted:[]};
  selection=editSelection(selection,'add','011-m08');selection=editSelection(selection,'up','011-m08');selection=editSelection(selection,'adopt','011-m08');
  const url='http://127.0.0.1:8874/library/compare.html?'+encodeSelection(selection);
  assert.deepEqual(decodeSelection(url),selection);
  const restored=queryMechanisms(index,{selection:url});assert.deepEqual(restored.cards.map(m=>m.id),selection.ids);assert.deepEqual(restored.selection.adopted,['011-m08']);assert.equal(restored.connections.length,2);
  selection=editSelection(selection,'remove','011-m08');assert.deepEqual(selection.adopted,[]);
  const stale=restoreSelection({...selection,source_sha256:'0'.repeat(64),ids:['999-m99',...selection.ids]},index);
  assert.equal(stale.stale,true);assert.deepEqual(stale.unknown_ids,['999-m99']);
  const result=queryMechanisms(index,{selection:'?'+encodeSelection(stale)});assert.ok(result.warnings.length>=2);assert.ok(result.connections.some(c=>c.gap.includes('未知')));
  assert.throws(()=>decodeSelection('?selection={bad'),/JSON|position|property/i);
});
test('MCP资料支撑返回实际正文与JPEG，不接受任意文件路径',()=>{
  const loaded=readLibraryMechanism(root,{id:'011-m08',source_sha256:index.source_sha256});
  assert.ok(loaded.result.body.includes('## 运动指令'));assert.equal(Buffer.from(loaded.image,'base64').readUInt16BE(0),0xffd8);
  const overview=readLibraryMechanism(root,{id:'011-m08',part:'overview',include_storyboard:false});assert.ok(overview.result.body.includes('完整64宫格'));assert.equal(overview.image,undefined);
  assert.throws(()=>readLibraryMechanism(root,{id:'../../secret'}),/无效/);
  assert.throws(()=>localFile(root,'../README.md'),/无效/);
  assert.throws(()=>loadIndex(resolve(root,'missing-library')));
});
test('过期索引与指向库外的目录链接被拒绝',()=>{
  // 临时测试仅放索引，不复制视频；目录保留在系统临时区供失败诊断。
  const sandbox=mkdtempSync(join(tmpdir(),'motion-library-'));
  writeFileSync(join(sandbox,'case-catalogue.json'),JSON.stringify({cases:[]}));
  writeFileSync(join(sandbox,'mechanism-index.json'),JSON.stringify(index));
  assert.throws(()=>loadIndex(sandbox),/过期|损坏/);
  const inner=join(sandbox,'inner');mkdirSync(inner);
  symlinkSync(root,join(inner,'outside'),'junction');assert.throws(()=>localFile(inner,'outside/mechanism-index.json'),/越界/);
});
