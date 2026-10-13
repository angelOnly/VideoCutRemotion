import { promises as fs } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { z } from 'zod';
import { ProductionError, sha256, type Run, type RenderRequest } from './contracts.js';
import { decodedAudioSeconds, regular, json, writeJson, inside } from './files.js';
import { validateTemplate } from './template-package.js';
import type { DoubaoService } from '../../speech-services/src/doubao.js';
export const sentenceAuditSchema=z.object({timelineRef:z.string().min(1),speechBatchRequestIds:z.array(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)).min(1),renderRequestId:z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional()}).strict();
const normalized=(text:unknown)=>String(text??'').replace(/\s+/gu,'');
function ensure(value:unknown,message:string):asserts value {if(!value)throw new ProductionError('SENTENCE_AUDIO_INVALID',`句级音频审计失败：${message}`);}
function integer(value:number,message:string){ensure(Number.isInteger(value)&&value>=0,message);return value;}
async function taskFile(root:string,source:string){ensure(typeof source==='string'&&source.length>0&&!isAbsolute(source)&&!source.startsWith('\\'),'音频必须是本工程 public 内相对路径');const path=await regular(root,source);ensure((await fs.stat(path)).size>0,'音频文件为空');return path;}
// 固定规则移植自模板句级审计器：使用 PCM 采样长度，不运行模板携带的任意脚本。
export function splitNaturalSentences(text:string) {
  const closing = new Set(['”', '’', '」', '』', '）', ')', ']', '】']);
  const endings = new Set(['。', '！', '？', '!', '?', '；', ';']);
  const sentences = [];
  let current = '';
  const chars = Array.from(String(text || ''));
  for (let index = 0; index < chars.length; index += 1) {
    current += chars[index];
    if (!endings.has(chars[index])) continue;
    while (index + 1 < chars.length && closing.has(chars[index + 1])) {
      current += chars[++index];
    }
    if (normalized(current)) sentences.push(current.trim());
    current = '';
  }
  if (normalized(current)) sentences.push(current.trim());
  return sentences;
}

async function auditSentenceAudio({plan, tts, timeline, publicDirectory, signal}: {plan:any;tts:any[];timeline:any;publicDirectory:string;signal?:AbortSignal}) {
  ensure(Array.isArray(plan.scenes) && plan.scenes.length > 0, '确认方案没有分镜');
  ensure(Array.isArray(tts), 'TTS 清单必须为数组');
  ensure(Number.isFinite(timeline.fps) && timeline.fps > 0, 'timeline.fps 无效');
  ensure(Array.isArray(timeline.scenes), 'timeline.scenes 必须为数组');

  const timelineByScene = new Map<string,any>(timeline.scenes.map((scene:any) => [scene.id, scene]));
  ensure(timelineByScene.size===timeline.scenes.length, 'timeline 场景编号重复');
  const ttsIds = new Set();
  const report: {fps:number;scenes:any[];recommendations:any[]} = {fps: timeline.fps, scenes: [], recommendations: []};

  for (const scene of plan.scenes) {
    const expectedText = normalized(scene.text);
    ensure(expectedText.length > 0, `${scene.id} 没有可配音句子`);
    const requested = tts.filter((item) => item.sceneId === scene.id);
    // 一个确认分镜可拆成多条短句，但原稿文字、标点及顺序不能改变。
    ensure(requested.length > 0 && requested.map((item) => normalized(item.text)).join('') === expectedText,
      `${scene.id} 短句 TTS 拼接后必须等于确认原稿`);
    const rendered = timelineByScene.get(scene.id);
    ensure(rendered, `${scene.id} 缺少 timeline 场景`);
    ensure(Array.isArray(rendered.utterances), `${scene.id} 缺少 utterances`);
    ensure(Array.isArray(rendered.captions), `${scene.id} 缺少 captions`);
    ensure(rendered.utterances.length === requested.length,
      `${scene.id} 的 utterances 数量不等于短句 TTS 数量`);
    const timing = rendered.captionTiming;
    let aligned;
    if (timing) {
      const file = await taskFile(publicDirectory, timing.src);
      ensure(sha256(await fs.readFile(file)) === timing.sha256, `${scene.id} 对齐记录摘要不符`);
      aligned = await json(file);
      ensure(['provider_timestamps', 'forced_alignment', 'reviewed_timestamps'].includes(aligned.method), '分页必须提供可靠时间依据，不能按字数比例切分');
    } else ensure(rendered.captions.length === requested.length, `${scene.id} 多页字幕须提供音频绑定的对齐记录`);

    ensure(rendered.captions.map((c:any) => normalized(c.text)).join('') === expectedText, `${scene.id} 字幕丢字或顺序不符`);
    let captionEnd = 0;
    for (const c of rendered.captions) {
      ensure(Number.isInteger(c.startFrame) && Number.isInteger(c.endFrameExclusive) && c.startFrame >= captionEnd && c.endFrameExclusive > c.startFrame && c.endFrameExclusive <= rendered.frames, `${scene.id} 字幕越界或重叠`);
      captionEnd = c.endFrameExclusive;
    }
    const usedCaptions = new Set();
    let previousEnd = -1;
    for (let index = 0; index < requested.length; index += 1) {
      const item = requested[index];
      const utterance = rendered.utterances[index];
      ensure(typeof item.id === 'string' && item.id && !ttsIds.has(item.id), `${scene.id} 的 TTS id 重复或为空`);

      ttsIds.add(item.id);
      ensure(normalized(item.text).length > 0, `${scene.id} 配音文本为空`);
      if (Array.from(String(item.text)).length > 28 || splitNaturalSentences(item.text).length > 1)
        report.recommendations.push({sceneId: scene.id, utteranceId: item.id, message: '建议短句字幕；复用音频，检查换行或按可靠对齐记录分页'});
      ensure(utterance.id === item.id && normalized(utterance.text) === normalized(item.text),
        `${scene.id} 第 ${index + 1} 条 timeline utterance 与 TTS 清单不一致`);
      const start = integer(utterance.startFrame, `${scene.id} 第 ${index + 1} 条音频起帧无效`);
      const end = integer(utterance.endFrameExclusive, `${scene.id} 第 ${index + 1} 条音频止帧无效`);
      ensure(start < end && start >= previousEnd && end <= rendered.frames, `${scene.id} 的句级音频边界重叠或倒序`);
      previousEnd = end;
      const pages = rendered.captions.filter((c:any) => c.utteranceId === item.id);
      ensure(pages.length && pages.map((c:any) => normalized(c.text)).join('') === normalized(item.text), `${scene.id} 配音对应字幕不完整`);
      for (const c of pages) { ensure(c.startFrame >= start && c.endFrameExclusive <= end, `${scene.id} 字幕超出音频窗口`); usedCaptions.add(c); }
      if (aligned) {
        const evidence = aligned.utterances?.[item.id];
        const hash = sha256(await fs.readFile(await taskFile(publicDirectory, utterance.src)));
        ensure(evidence?.audioSha256 === hash, `${scene.id} 对齐记录不属于当前音频`);
        ensure(JSON.stringify(evidence.captions) === JSON.stringify(pages.map(({text, startFrame, endFrameExclusive}:any) => ({text, startFrame, endFrameExclusive}))), `${scene.id} 分页未使用对齐记录`);
      } else ensure(pages.length === 1 && pages[0].startFrame === start && pages[0].endFrameExclusive === end, `${scene.id} 字幕没有使用该句音频边界`);
      const seconds = await decodedAudioSeconds(await taskFile(publicDirectory, utterance.src), signal);
      const frameSeconds = (end - start) / timeline.fps;
      ensure(seconds <= frameSeconds + 1e-6 && frameSeconds - seconds <= 1 / timeline.fps + 0.02,
        `${scene.id} 第 ${index + 1} 条音频实际 ${seconds.toFixed(3)} 秒，与时间轴 ${frameSeconds.toFixed(3)} 秒不符`);
    }
    ensure(rendered.captions.length === usedCaptions.size, `${scene.id} 存在未绑定 TTS 的字幕`);
    report.scenes.push({id: scene.id, sentenceCount: requested.length});
  }
  ensure(timelineByScene.size === plan.scenes.length, 'timeline 场景与确认方案数量不一致');
  ensure(ttsIds.size === tts.length, 'TTS 清单存在未绑定分镜的条目');
  return report;
}

export async function verifySentenceAudio(run:Run,runRoot:string,raw:unknown,speech:DoubaoService,signal?:AbortSignal){
  const input=sentenceAuditSchema.parse(raw);
  if(run.stage!=='render'||run.state!=='running')throw new ProductionError('SPEECH_STAGE_FORBIDDEN','只有当前制作任务可检查音频');
  const project=input.renderRequestId?join(runRoot,'render-snapshots',input.renderRequestId,'project'):join(runRoot,'project');
  inside(await fs.realpath(runRoot),await fs.realpath(project));
  const manifest=await validateTemplate(project),publicDirectory=join(project,'renderer',manifest.publicAssetRoot);
  inside(await fs.realpath(project),await fs.realpath(publicDirectory));
  const timeline=await json(await regular(project,input.timelineRef));
  const tts:any[]=[];
  for(const id of input.speechBatchRequestIds){const batch=await speech.readBatch(id,run.runId,run.accountId);ensure(batch.state==='succeeded',`配音批次 ${id} 尚未全部成功`);
    for(const job of batch.jobs){const item={id:job.request.segmentId,sceneId:job.request.sceneId,text:job.request.text};
      const scene=timeline.scenes?.find((s:any)=>s.id===item.sceneId),utterance=scene?.utterances?.find((u:any)=>u.id===item.id);
      ensure(utterance,`缺少句段 ${item.id}`);const path=await taskFile(publicDirectory,utterance.src);
      ensure(sha256(await fs.readFile(path))===job.sha256,`句段 ${item.id} 没有绑定本批次的真实音频`);tts.push(item);
    }
  }
  const plan={scenes:(run.request as RenderRequest).dataList.map(s=>({id:s.id,text:s.content}))};
  const report=await auditSentenceAudio({plan,tts,timeline,publicDirectory,signal});
  const path=join(runRoot,'checks',`sentence-audio-${input.renderRequestId??'working'}.json`);
  await writeJson(path,{...report,runId:run.runId,checkedAt:new Date().toISOString(),timelineSha256:sha256(canonicalTimeline(timeline)),scope:'句段、字幕、PCM 时长及音频归属；不代替听审'});
  return {...report,path};
}
function canonicalTimeline(value:unknown){return JSON.stringify(value);}
