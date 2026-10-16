"""将已授权财经模板整理成服务合同包；不改共享原件，不生成本期作品。"""
import argparse, json, shutil, zipfile, hashlib, subprocess, runpy, re
from pathlib import Path

p=argparse.ArgumentParser();p.add_argument('--source',required=True);p.add_argument('--output',required=True);a=p.parse_args()
source=Path(a.source).resolve();output=Path(a.output).resolve()
source_manifest=json.loads((source/'renderer/renderer-manifest.json').read_text(encoding='utf-8'))
# 此整理器只接完整时间线模板，逐镜头 props 模板必须走各自的适配流程。
if not source_manifest.get('wholeComposition') or not source_manifest.get('timelineModule'):
    raise SystemExit('源模板不是完整时间线合同，缺少 wholeComposition 或 timelineModule；未创建发行包')
if output.exists(): raise SystemExit('目标已存在，请明确使用新的包目录，避免覆盖冻结模板')
output.mkdir(parents=True)
shutil.copytree(source/'renderer',output/'renderer')
public=output/'renderer'/'public';public.mkdir()
shutil.copytree(source/'assets',public/'template-assets'/'assets')
for name in ['动效组件与内容适配说明.md']:
    text=(source/name).read_text(encoding='utf-8')
    text=text.replace('由共享工具顺序追加','由完整 Composition 播放').replace('由 stage_media 追加','由完整 Composition 播放')
    text=re.sub(r'(?<!template-assets/)assets/', 'template-assets/assets/', text)
    text=text.replace('共同字段：`id/kind/startFrame/endFrameExclusive/slot/props`。', '共同字段：`id/kind/startFrame/slot/props`；`endFrameExclusive` 可省略，表示持续到所属镜头或章节的实际末尾；显式止帧及语义动作点保持原帧数，不按配音新时长等比例缩放。')
    text=re.sub(r'^`contentFrames`.*$', '声音窗口直接取当前分镜实际范围；片尾独立播放，不保留第二份声音截止帧。音效未填写 `durationFrames` 时按素材实际时长检查；需要裁切时明确填写时长。配音、字幕和音效不得越过实际分镜或片尾起点。', text, flags=re.M)
    (output/name).write_text(text,encoding='utf-8')
shutil.copyfile(Path(__file__).parent/'finance-template-patches'/'创作说明.md',output/'创作说明.md')
shutil.copyfile(Path(__file__).parent/'finance-template-patches'/'文字分析合同.md',output/'文字分析合同.md')
manifest=json.loads((output/'renderer/renderer-manifest.json').read_text(encoding='utf-8'))
manifest.pop('rules',None);manifest.pop('motionGuide',None);manifest.pop('endingPolicy',None)
# 人物映射属于本模板，通用 Worker 不认识栏目角色。
manifest['speakerBindings']={
    '财小策':{'speaker':'female-host','voiceRef':'finance.female'},
    '室长':{'speaker':'male-chief','voiceRef':'finance.male'},
}
manifest['captionTimingPolicy']='authored'
manifest.update(templateVersion='2.0.10',timelineDataRef='timeline.json',timelineContract='sentence-timeline/1',timelineValidator='src/validateTimeline.ts',analysisInstructions=['../文字分析合同.md'],instructions=['../创作说明.md','../动效组件与内容适配说明.md'],publicAssetRoot='public',width=1920,height=1080,fps=30,voiceRefs=['finance.female','finance.male'])
(output/'renderer/renderer-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
file=output/'renderer/src/FinancialDialogue.tsx';s=file.read_text(encoding='utf-8').replace('AbsoluteFill, Audio,','AbsoluteFill, Audio, OffthreadVideo,')
start=s.index('export const FinanceEpisode:')
s=s[:start]+'''// 片尾直接纳入完整 Composition，分镜始终沿全局时间导出。
export const FinanceEpisode: React.FC<{timeline: FinanceTimeline}> = ({timeline}) => {
  const ending=timeline.ending;
  return <AbsoluteFill>
    {timeline.scenes.map((scene) => {
      // 正文在片尾开始时卸载，避免高层级人物卡穿透原片尾。
      const frames=ending?.outro ? Math.min(scene.frames,ending.narrationEndFrame-scene.from) : scene.frames;
      return frames>0 ? <Sequence key={scene.id} from={scene.from} durationInFrames={frames}>
        <FinanceScene scene={scene} timeline={timeline} withBgm />
      </Sequence> : null;
    })}
    {ending?.outro ? <Sequence from={ending.narrationEndFrame} durationInFrames={ending.outro.frames}>
      <AbsoluteFill style={{backgroundColor:'#000'}}>
        <OffthreadVideo src={asset(ending.outro.src)} muted={ending.outro.muted} style={{width:'100%',height:'100%'}} />
      </AbsoluteFill>
    </Sequence> : null}
  </AbsoluteFill>;
};
'''
file.write_text(s,encoding='utf-8')
# Windows 的 resolve 返回反斜杠；用相对路径判断边界，不误拒合法音频。
validator=output/'renderer/scripts/verify-sentence-audio.mjs'
if validator.exists():
    s=validator.read_text(encoding='utf-8')
    s=s.replace("import {dirname, resolve} from 'node:path';", "import {dirname, resolve, relative, isAbsolute, sep} from 'node:path';")
    s=s.replace("require(file.startsWith(`${root}/`) || file === root, `音频越出 renderer/public：${source}`);", "const relativePath = relative(root, file);\n  require(relativePath !== '..' && !relativePath.startsWith('..' + sep) && !isAbsolute(relativePath), `音频越出 renderer/public：${source}`);")
    validator.write_text(s,encoding='utf-8')
font=Path(__file__).resolve().parents[1]/'packages/motion-work/fonts'
fonts=list(font.glob('*Sans*SC*.otf'))+list(font.glob('*Sans*SC*.ttf'))
if fonts:
    dest=public/'fonts';dest.mkdir();shutil.copyfile(fonts[0],dest/fonts[0].name)
    entry=output/'renderer/src/index.ts';s=entry.read_text(encoding='utf-8');s='import {staticFile, delayRender, continueRender} from "remotion";\n'+s
    s+='\nconst fontHandle=delayRender("加载模板中文字体");\nconst font=new FontFace("Noto Sans CJK SC",`url(${staticFile("fonts/'+fonts[0].name+'")})`);\nfont.load().then(f=>{document.fonts.add(f);continueRender(fontHandle);});\n'
    entry.write_text(s,encoding='utf-8')
runpy.run_path(str(Path(__file__).with_name('patch-finance-template.py')))['patch_template'](output)
# 纯校验只加载参数规则，不能经注册表带入 React 组件。
src=output/'renderer/src'
f=src/'validateTimeline.ts'
s=f.read_text(encoding='utf-8').replace("import {visualExtensions} from './visualExtensions';", "import {visualValidators} from './visualValidators';")
s=s.replace('visualExtensions[b.kind]', 'visualValidators[b.kind]').replace("extension && typeof extension.component === 'function' && typeof extension.validate === 'function'", "typeof extension === 'function'").replace('extension.validate(b)', 'extension(b)')
f.write_text(s,encoding='utf-8')
(src/'visualValidators.ts').write_text("import type {VisualBlock} from './types';\n// 这里只导入纯参数规则，禁止导入画面组件。\nexport const visualValidators: Record<string, (block: VisualBlock) => void> = {};\n",encoding='utf-8')
subprocess.run(['node', str(Path(__file__).with_name('verify-finance-template.mjs')), str(output)], check=True)
archive=output.with_suffix('.zip')
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
    for f in sorted(output.rglob('*')):
        if f.is_file():z.write(f,f.relative_to(output).as_posix())
print(json.dumps({'zip':str(archive),'sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'bytes':archive.stat().st_size},ensure_ascii=False))
