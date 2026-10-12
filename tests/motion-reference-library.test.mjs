import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,readdirSync,mkdtempSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {searchCases} from '../references/motion-cases/skillry/search.mjs';
import {parseMechanism,resolveLibraryLink} from '../references/motion-cases/skillry/document-format.mjs';
import {buildIndex,selectMechanisms} from '../references/motion-cases/skillry/tools/mechanisms.mjs';
const root=new URL('../references/motion-cases/skillry/',import.meta.url);
const catalogue=JSON.parse(readFileSync(new URL('case-catalogue.json',root),'utf8'));
const cases=catalogue.cases;
test('正式库恰有120个案例，已转换案例的总览与机制成对完整',()=>{
  assert.equal(cases.length,120);assert.equal(new Set(cases.map(c=>c.slug)).size,120);
  assert.equal(readdirSync(new URL('cases/',root)).length,120);
  for(const c of cases){
    const mechanism=c.analysis_kind==='mechanisms-v1';
    assert.deepEqual(readdirSync(new URL(c.directory+'/',root)).sort(),mechanism?['mechanisms','overview.md','storyboard.jpg','video.mp4']:['analysis.md','video.mp4']);
    if(mechanism){
      assert.equal(c.storyboard,c.directory+'/storyboard.jpg');
      const picture=readFileSync(new URL(c.storyboard,root));
      assert.equal(picture.readUInt16BE(0),0xffd8,'正式分镜为 JPEG 文件');
    }else assert.equal(c.storyboard,undefined);
    for(const k of ['media','analysis']){assert.ok(!c[k].includes(':')&&!c[k].startsWith('/'));assert.ok(existsSync(new URL(c[k],root)));}
    assert.equal(new URL(c.detail,'http://localhost/').pathname,'/detail.html');
    for(const s of c.recommended_segments)assert.ok(s.start>=0&&s.end>s.start&&s.end<=c.duration);
    const text=readFileSync(new URL(c.analysis,root),'utf8');
    const sections=mechanism?['运动总览','完整64宫格']:['适用场景','动效与美术拆解','实现建议','作者公开输入与来源','观看与文件说明'];
    for(const section of sections)assert.ok(text.includes(section),`${c.case_number} ${section}`);
    if(mechanism){
      assert.ok(!/\d+(?:\.\d+)?\s*秒|第\s*\d+\s*格/.test(text));
      const expected=[];
      for(const id of c.mechanism_ids){
        const stem=id.split('-')[1];expected.push(stem+'.md',stem+'.jpg');
        assert.ok(text.includes(`](mechanisms/${stem}.md)`),`${id} 应在总览中被引用`);
        const document=c.directory+`/mechanisms/${stem}.md`;
        const {metadata,body}=parseMechanism(readFileSync(new URL(document,root),'utf8'));
        assert.equal(metadata.id,id);assert.equal(metadata.case_number,c.case_number);
        assert.ok(metadata.clip,`${id} 应有独立视频切片`);
        if(metadata.clip){
          expected.push(stem+'.mp4');
          assert.equal(metadata.clip.path,document.replace(/\.md$/,'.mp4'));
          assert.equal(metadata.clip.source_sha256,c.media_sha256);
          assert.ok(metadata.clip.end_ms<=Math.ceil(c.duration*1000));
          const clip=readFileSync(new URL(metadata.clip.path,root));
          assert.equal(clip.length,metadata.clip.bytes);assert.equal(createHash('sha256').update(clip).digest('hex'),metadata.clip.sha256);
          assert.equal(clip.toString('ascii',4,8),'ftyp');assert.ok(body.includes(`](${stem}.mp4)`));
        }
        assert.ok(body.includes(`](${stem}.jpg)`));
        assert.ok(!/\d+(?:\.\d+)?\s*秒|第\s*\d+\s*格/.test(body));
        for(const heading of ['## 运动指令','## 分镜过程','## 组合与调整'])assert.ok(body.includes(heading));
        const picture=readFileSync(new URL(document.replace(/\.md$/,'.jpg'),root));
        assert.equal(picture.readUInt16BE(0),0xffd8);
      }
      assert.deepEqual(readdirSync(new URL(c.directory+'/mechanisms/',root)).sort(),expected.sort());
    }
    for(const link of text.matchAll(/\]\(([^)]+)\)/g)){
      const resolved=resolveLibraryLink(link[1],c.analysis);assert.ok(resolved,'资料链接不得越界');
      if(resolved.kind==='local')assert.ok(existsSync(new URL(resolved.path,root)),'拆解不依赖已归档文件');
    }
  }
  const converted=cases.filter(c=>c.analysis_kind==='mechanisms-v1');
  assert.ok(converted.length>0);
  const index=buildIndex();
  assert.deepEqual(index.mechanisms.map(m=>m.id).sort(),converted.flatMap(c=>c.mechanism_ids).sort());
  assert.ok(index.scope.includes(`${converted.length} / ${cases.length}`));
});

test('切片范围和路径拒绝无效值，正文没有强制新片秒数',()=>{
  const index=buildIndex(),sample=index.mechanisms.find(m=>m.clip);
  assert.ok(sample,'有实际切片样例');
  const text=readFileSync(new URL(sample.document,root),'utf8');
  for(const invalid of [{start_ms:-1},{end_ms:sample.clip.start_ms},{path:'../private.mp4'},{bytes:0},{sha256:'bad'}]){
    const changed=text.replace(/^clip: .*$/m,'clip: '+JSON.stringify({...sample.clip,...invalid}));
    assert.throws(()=>parseMechanism(changed),/切片元数据无效/);
  }
});
test('批量续跑验证已有切片后跳过，范围不同或重复编号明确拒绝且不改文件',()=>{
  const m=buildIndex().mechanisms.find(m=>m.id==='002-m17'),clip=m.clip;
  const docUrl=new URL(m.document,root),mediaUrl=new URL(clip.path,root);
  const before=[readFileSync(docUrl),readFileSync(mediaUrl)];
  const directory=mkdtempSync(join(tmpdir(),'motion-clip-resume-')),plan=join(directory,'plan.json');
  const item={id:m.id,start_ms:clip.start_ms,end_ms:clip.end_ms,boundary_note:clip.boundary_note,source_sha256:clip.source_sha256};
  const run=items=>{writeFileSync(plan,JSON.stringify(items));return spawnSync(process.execPath,[fileURLToPath(new URL('tools/build-mechanism-clip.mjs',root)),'--batch',plan],{cwd:fileURLToPath(new URL('../',import.meta.url)),encoding:'utf8'});};
  try{
    const resumed=run([item]);assert.equal(resumed.status,0,resumed.stderr);assert.match(resumed.stdout,/已验证并跳过/);
    const changed=run([{...item,end_ms:item.end_ms+1}]);assert.notEqual(changed.status,0);assert.match(changed.stderr,/停止覆盖/);
    const duplicate=run([item,item]);assert.notEqual(duplicate.status,0);assert.match(duplicate.stderr,/重复/);
    assert.deepEqual(readFileSync(docUrl),before[0]);assert.deepEqual(readFileSync(mediaUrl),before[1]);
  }finally{
    assert.equal(dirname(realpathSync(directory)),realpathSync(tmpdir()),'只清理本测试创建的临时目录');
    rmSync(directory,{recursive:true,force:true});
  }
});
test('120个实际交付视频哈希正确，第001条明确转码身份',()=>{
  for(const c of cases){const data=readFileSync(new URL(c.media,root));assert.equal(data.length,c.media_bytes);assert.equal(createHash('sha256').update(data).digest('hex'),c.media_sha256);if(c.case_number!==1)assert.equal(c.media_sha256,c.source_sha256);}
  assert.match(cases[0].media_note,/转换/);assert.notEqual(cases[0].media_sha256,cases[0].source_sha256);
});
test('材料与用途检索保留代表例，并且无结果不擅自放宽',()=>{
  assert.ok(searchCases(cases,{query:'手机 照片',limit:5}).some(c=>c.case_number===43));
  assert.ok(searchCases(cases,{query:'新闻 对照',limit:5}).some(c=>c.case_number===51));
  assert.ok(searchCases(cases,{query:'跨尺度'}).some(c=>c.case_number===71));
  assert.deepEqual(searchCases(cases,{query:'071'}).map(c=>c.case_number),[71]);
  const found=searchCases(cases,{filters:{video_types:'新闻解读',materials:'人物视频'}});
  assert.ok(found.length>0&&!found.some(c=>c.case_number===51));
  assert.deepEqual(searchCases(cases,{query:'绝不存在的观看任务'}),[]);
});
test('共用入口有效，Skill按需读取机制且不再依赖研究日志',()=>{
  for(const f of ['index.html','detail.html','detail.mjs','catalogue-ui.mjs','catalogue.css','search.mjs','README.md','tools/preview_server.py','tools/search-cases.mjs','mechanisms.html','mechanisms-ui.mjs','mechanism-index.json','tools/mechanisms.mjs'])assert.ok(existsSync(new URL(f,root)));
  const skill=readFileSync(new URL('../.agents/skills/motion-case-library/SKILL.md',import.meta.url),'utf8')+readFileSync(new URL('../.agents/skills/motion-case-library/references/mechanism-retrieval.md',import.meta.url),'utf8');
  const guide=readFileSync(new URL('../.agents/skills/motion-case-library/references/skillry-retrieval.md',import.meta.url),'utf8');
  // Skill 可将机制方法移到按需资料中，核验真实入口和对应正文。
  const route='references/mechanism-retrieval.md';
  const mechanismGuide=skill.includes(route)?readFileSync(new URL('../.agents/skills/motion-case-library/'+route,import.meta.url),'utf8'):skill;
  assert.ok(skill.includes('search_motion_mechanisms')&&skill.includes('read_motion_mechanism'));
  assert.ok(mechanismGuide.includes('起止关系')&&mechanismGuide.includes('按需')&&mechanismGuide.includes('向量'));
  assert.ok(!guide.includes('sources/published-prompt.md')&&!guide.includes('不随Git传递'));
  const names=readdirSync(root);for(const forbidden of ['staging','sources','screenshots','related-sources','code-view','catalogue-parts','manifest.json'])assert.ok(!names.includes(forbidden));
  assert.ok(!names.some(n=>/\.(zip|png|jpg)$/.test(n)));
});

test('机制派生索引与正文一致，分页不漏项，未知编号不静默丢弃',()=>{
  const index=JSON.parse(readFileSync(new URL('mechanism-index.json',root),'utf8'));
  assert.deepEqual(index,buildIndex());
  const found=[];let offset=0;
  for(;;){
    const page=selectMechanisms(index,{offset,limit:7});
    assert.equal(page.source_sha256,index.source_sha256);assert.equal(page.scope,index.scope);found.push(...page.cards.map(c=>c.id));
    if(page.exhausted)break;offset=page.next_offset;
  }
  assert.deepEqual(found,index.mechanisms.map(c=>c.id));
  assert.deepEqual(selectMechanisms(index,{ids:[found.at(-1),found[0]]}).cards.map(c=>c.id),[found.at(-1),found[0]]);
  assert.throws(()=>selectMechanisms(index,{ids:['999-m99']}),/未知/);
  assert.throws(()=>selectMechanisms(index,{ids:[found[0],found[0]]}),/重复/);
  assert.throws(()=>selectMechanisms(index,{offset:-1}),/范围/);
});

test('机制资料允许库内相对图文引用，拒绝脚本和越界链接',()=>{
  const base='cases/example/mechanisms/m01.md';
  assert.deepEqual(resolveLibraryLink('m01.jpg',base),{kind:'local',path:'cases/example/mechanisms/m01.jpg',hash:''});
  assert.equal(resolveLibraryLink('../overview.md',base).path,'cases/example/overview.md');
  for(const link of ['javascript:alert(1)','data:text/html,abc','../../../../secret.md','/secret.md','..\\secret.md','%2e%2e/%2e%2e/%2e%2e/%2e%2e/secret.md'])assert.equal(resolveLibraryLink(link,base),null);
  assert.throws(()=>parseMechanism('---\nid: "002-m01"\nid: "002-m02"\n---\n正文'),/重复/);
});
