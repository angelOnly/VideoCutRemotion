import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {processFile} from '../packages/production-service/src/files.js';

test('财经模板转换统一素材路径，只将原末端覆盖改为跟随当前范围',async()=>{
  const root=await mkdtemp(join(tmpdir(),'finance-template-contract-'));
  try{
    await mkdir(join(root,'renderer'),{recursive:true});
    const fixture={fps:30,totalFrames:100,chapters:[{from:0,endFrameExclusive:100,visualBlocks:[
      {id:'follow',startFrame:0,endFrameExclusive:100,props:{revealFrame:11}},
      {id:'exit',startFrame:20,endFrameExclusive:70,props:{revealFrame:13}},
    ]}],scenes:[{from:0,frames:100,contentFrames:80,visualBlocks:[],
      intro:{src:'assets/video/intro/source.mov'},utterances:[{src:'audio/本期短句.wav'}],
    }],bgm:{src:'assets/audio/bgm/source.mp3'},ending:{closingUtteranceIds:[],narrationEndFrame:100,holdFrame:70}};
    await writeFile(join(root,'renderer/timeline.json'),JSON.stringify(fixture));
    await processFile('python3',['-c',"import runpy,sys;runpy.run_path('scripts/patch-finance-template.py')['normalize_timeline'](sys.argv[1])",root]);
    const actual=JSON.parse(await readFile(join(root,'renderer/timeline.json'),'utf8'));
    assert.equal('contentFrames' in actual.scenes[0],false);
    assert.equal(actual.scenes[0].intro.src,'template-assets/assets/video/intro/source.mov');
    assert.equal(actual.scenes[0].utterances[0].src,'speech/本期短句.wav');
    assert.equal(actual.bgm.src,'template-assets/assets/audio/bgm/source.mp3');
    assert.equal('holdFrame' in actual.ending,false);
    assert.equal('endFrameExclusive' in actual.chapters[0].visualBlocks[0],false);
    assert.deepEqual(actual.chapters[0].visualBlocks[1],fixture.chapters[0].visualBlocks[1]);
    assert.equal(actual.chapters[0].visualBlocks[0].props.revealFrame,11);
    assert.deepEqual(JSON.parse(await readFile(join(root,'renderer/timeline.example.json'),'utf8')),actual);
  }finally{await rm(root,{recursive:true,force:true});}
});
