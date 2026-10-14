import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analysisTemplateInput, readAnalysisContract, validateTemplate } from '../packages/production-service/src/template-package.js';
import { writeJson } from '../packages/production-service/src/files.js';
import { taskInstruction } from '../packages/production-service/src/task-instructions.js';
import { AppServerClient, prepareStageSkills, verifyStageSkills, verifyStageTools } from '../packages/production-service/src/codex-session.js';
import type { Run } from '../packages/production-service/src/contracts.js';

async function fixture(){
  const root=await fs.mkdtemp(join(tmpdir(),'analysis-boundary-'));
  await fs.mkdir(join(root,'renderer/public'),{recursive:true});
  await fs.writeFile(join(root,'制作.md'),'只给视觉作者的实现说明');
  await fs.writeFile(join(root,'文字.md'),'保留 AI、42.5%、数字与标点。\n不添加结束语。');
  await fs.writeFile(join(root,'renderer/scene.tsx'),'SOURCE_BODY_MUST_NOT_ENTER_ANALYSIS');
  await fs.writeFile(join(root,'renderer/timeline.ts'),'export {};');
  const manifest={schemaVersion:1,templateVersion:'test-2',instructions:['../制作.md'],analysisInstructions:['../文字.md'],entry:'scene.tsx',timelineModule:'timeline.ts',wholeComposition:'Main',publicAssetRoot:'public',width:1920,height:1080,fps:30};
  await writeJson(join(root,'renderer/renderer-manifest.json'),manifest);
  return {root,manifest};
}
test('Analysis 文字合同投影保留版本和摘要，不展开制作路径与组件正文',async()=>{
  const {root}=await fixture();try{
    const manifest=await validateTemplate(root),analysisContract=await readAnalysisContract(root,manifest);
    const projected=analysisTemplateInput({digest:'archive',manifest,analysisContract});
    assert.equal(projected.analysisInstructions[0].text,'保留 AI、42.5%、数字与标点。\n不添加结束语。');
    assert.equal(projected.analysisInstructions[0].path,'文字.md');assert.equal(projected.archiveDigest,'archive');
    assert.ok(!JSON.stringify(projected).includes('scene.tsx'));assert.ok(!JSON.stringify(projected).includes('SOURCE_BODY'));
    const differentVersion=await readAnalysisContract(root,{...manifest,templateVersion:'test-3'});assert.notEqual(differentVersion.digest,analysisContract.digest);
    await fs.writeFile(join(root,'文字.md'),'新文字约束');assert.notEqual((await readAnalysisContract(root,manifest)).digest,analysisContract.digest);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('新 Analysis 明确拒绝缺文字合同、源码引用、越界、空文及无效字段；旧工程仍能 Render 校验',async()=>{
  const {root,manifest}=await fixture();try{
    const valid=await validateTemplate(root);
    await assert.rejects(readAnalysisContract(root,{...valid,analysisInstructions:undefined}),/缺少 analysisInstructions/);
    for(const path of ['scene.tsx','../../../outside.md','/absolute.md','C:\\outside.md','../缺失.md'])await assert.rejects(readAnalysisContract(root,{...valid,analysisInstructions:[path]}),/analysisInstructions/);
    await fs.writeFile(join(root,'文字.md'),' \n');await assert.rejects(readAnalysisContract(root,valid),/内容为空/);
    await fs.writeFile(join(root,'文字.md'),Buffer.from([255]));await assert.rejects(readAnalysisContract(root,valid),/UTF-8/);
    await writeJson(join(root,'renderer/renderer-manifest.json'),{...manifest,analysisInstructions:[]});await assert.rejects(validateTemplate(root),/analysisInstructions/);
    const {analysisInstructions,...legacy}=manifest;await writeJson(join(root,'renderer/renderer-manifest.json'),legacy);assert.equal((await validateTemplate(root)).analysisInstructions,undefined);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('Analysis 提示不再加载制作合同或动效工具，发现校验按可信阶段分开',()=>{
  const instruction=taskInstruction({stage:'analysis',request:{}} as Run,'/run','/plugin');
  assert.ok(!instruction.includes('renderer-manifest.json'));assert.ok(!instruction.includes('synthesize_speech_batch'));assert.ok(!instruction.includes('search_motion_mechanisms'));assert.ok(!instruction.includes('并行主题审片'));
  const analysis={tools:{read_runtime_release:{},read_production_task:{}}};verifyStageTools(analysis,'analysis');
  assert.throws(()=>verifyStageTools({...analysis,tools:{...analysis.tools,render_template:{}}},'analysis'),/制作或动效/);
  assert.throws(()=>verifyStageTools(analysis,'render'),/必要工具/);
  const skills={data:[{skills:[{name:'production-coordinator',path:'/run/SKILL.md',scope:'repo',enabled:true}],errors:[]}]};
  verifyStageSkills(skills,['/run/SKILL.md']);
  assert.throws(()=>verifyStageSkills({data:[{skills:[...skills.data[0].skills,{name:'pages',path:'/pages/SKILL.md',scope:'user',enabled:true}]}]},['/run/SKILL.md']),/额外 pages/);
});
test('隔离宿主按 Run 固定阶段目录，实际 skills/list 不重新发现无关技能',{skip:!process.env.TEXTVIDEO_CODEX_PROBE_TESTS},async()=>{
  const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'analysis-skill-host-'))),runRoot=join(root,'run'),pluginRoot=join(root,'plugin'),codexHome=join(root,'home');
  const executable=process.env.TEXTVIDEO_CODEX_EXECUTABLE??'codex';
  try{
    const skill=join(pluginRoot,'skills-stages/analysis/production-coordinator');await fs.mkdir(skill,{recursive:true});
    await fs.writeFile(join(skill,'SKILL.md'),'---\nname: production-coordinator\ndescription: 测试文字阶段\n---\n只读文字。\n');
    const unrelated=join(codexHome,'skills/unrelated');await fs.mkdir(unrelated,{recursive:true});await fs.writeFile(join(unrelated,'SKILL.md'),'---\nname: unrelated\ndescription: 不应启用\n---\n无关正文。\n');
    const env={...process.env,CODEX_HOME:codexHome};
    const config=await prepareStageSkills('analysis',runRoot,pluginRoot,executable,env);
    const argument=`skills.config=[${config.overrides.map(item=>`{path=${JSON.stringify(item.path)},enabled=${item.enabled}}`).join(',')}]`;
    const client=new AppServerClient(executable,['app-server','-c','features.plugins=false','-c',argument],env,runRoot);
    try{await client.init();const result=await client.call('skills/list',{cwds:[runRoot],forceReload:true});const evidence=verifyStageSkills(result,config.paths);assert.deepEqual(evidence.enabled.map(s=>s.name),['production-coordinator']);}finally{await client.close();}
    assert.deepEqual(await prepareStageSkills('analysis',runRoot,pluginRoot,executable,env),config);
    await fs.writeFile(config.paths[0],'changed');await assert.rejects(prepareStageSkills('analysis',runRoot,pluginRoot,executable,env),/固定阶段技能已改变/);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
