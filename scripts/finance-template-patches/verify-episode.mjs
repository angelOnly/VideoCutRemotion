import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

/** 财经栏目标题必须来自本期确认稿；此规则随模板发布，不进入通用 Worker。 */
export function verifyEpisode(timeline, scenes) {
  for (const scene of timeline.scenes) {
    const name = scene.intro?.companyName;
    if (name == null) continue;
    const fail = () => { throw new Error(`${scene.id}：片头公司名须引用当前确认台词或章节，不能沿用旧公司`); };
    if (typeof name !== 'string' || !name.trim() || name.length > 100) fail();
    const evidence = scene.intro.companyEvidence;
    const target = scenes.find(item => item.id === evidence?.sceneId);
    const source = evidence?.field === 'content' ? target?.content
      : evidence?.field === 'chapter' ? target?.directing?.chapter : undefined;
    if (typeof source !== 'string' || !Number.isInteger(evidence?.start) || !Number.isInteger(evidence?.end)
      || evidence.start < 0 || evidence.end <= evidence.start || evidence.end > source.length
      || !source.slice(evidence.start, evidence.end).includes(name)) fail();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const readOption = name => {
    const index = process.argv.indexOf(name);
    if (index < 0 || !process.argv[index + 1]) throw new Error(`缺少参数 ${name}`);
    return JSON.parse(readFileSync(resolve(process.argv[index + 1]), 'utf8'));
  };
  verifyEpisode(readOption('--timeline'), readOption('--input').request.dataList);
  console.log('财经模板本期标题来源检查通过');
}
