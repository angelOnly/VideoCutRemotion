import { readFile, writeFile, mkdir, realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_VOICE_WORKFLOW_ID = 'omnivoice-default-reference-v1';

/** 从已有克隆工作流提取服务端配置，不把某台机器的音频路径写死进代码。 */
export async function configureDefaultVoice({ workflowPath, inputRoot, outputDirectory }) {
  const source = JSON.parse(await readFile(workflowPath, 'utf8'));
  const snapshot = source.extra?.comfyuiBridge;
  if (snapshot?.status !== 'ready' || !snapshot.apiPrompt) throw new Error('原音色工作流尚未保存有效 Bridge 快照');
  const media = snapshot.inputMappings.filter(mapping => mapping.kind === 'audio');
  if (media.length !== 1) throw new Error('默认音色工作流必须明确且仅有一个参考音频输入');
  const mapping = media[0];
  const reference = snapshot.apiPrompt[mapping.nodeId]?.inputs?.[mapping.inputName];
  if (typeof reference !== 'string' || !reference.trim()) throw new Error('原工作流未配置本地参考音频');
  const root = await realpath(inputRoot);
  const file = await realpath(resolve(root, reference)).catch(() => { throw new Error('默认参考音频不存在，请修复服务端已有音色配置'); });
  const offset = relative(root, file);
  if (isAbsolute(offset) || offset.startsWith('..') || !(await stat(file)).isFile()) throw new Error('默认参考音频必须位于 ComfyUI input 目录内');
  const fields = snapshot.inputMappings.filter(item => !['audio', 'video', 'image'].includes(item.kind));
  if (fields.length !== 1 || fields[0].kind !== 'text') throw new Error('默认音色入口只支持一个待合成文本输入');
  const manifest = {
    id: DEFAULT_VOICE_WORKFLOW_ID, name: 'OmniVoice 服务端已有本地音色',
    apiPromptFile: `${DEFAULT_VOICE_WORKFLOW_ID}.json`,
    inputMappings: fields.map(({ widgetRef, ...field }) => ({ ...field, required: true })),
    outputMappings: snapshot.outputMappings
  };
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(outputDirectory, manifest.apiPromptFile), JSON.stringify(snapshot.apiPrompt, null, 2) + '\n');
  await writeFile(join(outputDirectory, `${DEFAULT_VOICE_WORKFLOW_ID}.bridge.json`), JSON.stringify(manifest, null, 2) + '\n');
  return { workflowId: manifest.id, reference, outputDirectory };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [workflowPath, inputRoot, outputDirectory] = process.argv.slice(2);
  if (!workflowPath || !inputRoot || !outputDirectory) throw new Error('用法：configure-default-voice.mjs <已有工作流> <ComfyUI input目录> <目标API工作流目录>');
  console.log(JSON.stringify(await configureDefaultVoice({ workflowPath, inputRoot, outputDirectory })));
}
