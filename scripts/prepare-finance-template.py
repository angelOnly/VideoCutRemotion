"""将已授权财经模板整理成服务合同包；不改共享原件，不生成本期作品。"""
import argparse, json, shutil, zipfile, hashlib
from pathlib import Path

p=argparse.ArgumentParser();p.add_argument('--source',required=True);p.add_argument('--output',required=True);a=p.parse_args()
source=Path(a.source).resolve();output=Path(a.output).resolve()
if output.exists(): raise SystemExit('目标已存在，请明确使用新的包目录，避免覆盖冻结模板')
output.mkdir(parents=True)
shutil.copytree(source/'renderer',output/'renderer')
public=output/'renderer'/'public';public.mkdir()
shutil.copytree(source/'assets',public/'template-assets'/'assets')
for name in ['动效组件与内容适配说明.md']:
    text=(source/name).read_text(encoding='utf-8')
    text=text.replace('由共享工具顺序追加','由完整 Composition 播放').replace('由 stage_media 追加','由完整 Composition 播放')
    (output/name).write_text(text,encoding='utf-8')
(output/'创作说明.md').write_text('''# 财经双人模板生产说明

此包只提供栏目固定包装与组件接口，原稿及确认正文来自本次任务输入。完整读取动效组件与内容适配说明、renderer/src/types.ts、validateTimeline.ts、VisualBlocks.tsx、visualExtensions.tsx、FinancialDialogue.tsx。

本模板固定为 1920×1080、30fps。保留男女头像、Logo、SpeakerStage、栏目背景、中央面板外壳、导航、全片进度及字幕区。发言按语义由男女两位承担，允许一人连续多句，不机械逐句轮换，不添加新对白。voiceRef 为 finance.female 与 finance.male，实际音色由服务器配置。

中央图解由本期作者在 src/visualExtensions.tsx 注册并实现；可以增加独立源码文件。保留正文原文、顺序、数字及原意，分镜内部按自然句段配音、实测时长；字幕按真实句段，拼接应完全等于确认正文。本文不提供本期章节数量或固定动效菜单。

全部音频及素材放 renderer/public。staticFile 的路径从 public 起，例如 template-assets/assets/images/brand/logo-dark.png。豆包工具返回音频先复制到 public/speech/ 后绑定，不引用机器个人目录。保留原 BGM，按发言压低音乐；音效依据落点适量安排。

片头使用 assets/video/intro 中原件，在开场钩子之后或正文之前安排；不得截断或遮蔽已确认口播。片尾使用 assets/video/outro 中原件，在全部口播结束后完整播放一次。ending.narrationEndFrame 为片尾开始全局帧；ending.outro.frames 来自原件实测；totalFrames 包含片尾。源码已把片尾纳入 FinanceEpisode，不再用占位视频后替换流程；没有结束语授权不加稿。

本期 timeline.ts 和一份实际 timeline.json 必须同步保存。保持模板时序和 LayoutGuard 检查，不删除校验来通过渲染。使用本插件预览和渲染工具，整片及分镜全部使用 FinanceEpisode，全局帧 ranges 对应确认分镜，不能用 FinanceScene-* 重置全片时间。正式交付 N+1 文件，整片在前。

依赖已由部署提供，任务期间不安装包。模板 Arial 等西文字体仅用于拉丁文字；中文使用包内 Noto Sans SC。技术探测与抽帧不等于完整连续视听，检查真实范围如实记录。保护外观、正文图解、头像、Logo、字幕、片头片尾及声音均需实际核查。
''',encoding='utf-8')
manifest=json.loads((output/'renderer/renderer-manifest.json').read_text(encoding='utf-8'))
manifest.pop('rules',None);manifest.pop('motionGuide',None);manifest.pop('endingPolicy',None)
manifest.update(templateVersion='2.0.1',instructions=['../创作说明.md','../动效组件与内容适配说明.md'],publicAssetRoot='public',width=1920,height=1080,fps=30,voiceRefs=['finance.female','finance.male'])
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
archive=output.with_suffix('.zip')
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
    for f in sorted(output.rglob('*')):
        if f.is_file():z.write(f,f.relative_to(output).as_posix())
print(json.dumps({'zip':str(archive),'sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'bytes':archive.stat().st_size},ensure_ascii=False))
