"""针对已知模板源码实施有限补丁，源结构不符时停止，禁止静默漏补。"""
from pathlib import Path
import shutil, json, re

def once(text, old, new):
    if text.count(old) != 1:
        raise ValueError('模板源码结构不符，需人工核对补丁锚点：' + old[:100])
    return text.replace(old, new, 1)

def adapt_timeline(output):
    renderer = Path(output) / 'renderer'
    source = renderer / 'src/timeline.ts'
    text = source.read_text(encoding='utf-8')
    # 只迁移已知的 JSON 字面量，不执行模板脚本，也不猜测 TypeScript 表达式。
    match = re.search(r'export const timeline: FinanceTimeline = (\{.*\});\s*$', text, re.S)
    if not match:
        raise ValueError('模板 timeline.ts 不是支持的 JSON 字面量，请核对维护源')
    literal = match.group(1)
    json.loads(literal)
    (renderer / 'timeline.json').write_text(literal + '\n', encoding='utf-8')
    source.write_text("import type {FinanceTimeline} from './types';\nimport timelineData from '../timeline.json';\n\n// 渲染与服务读取同一份 JSON，作者只修改 timeline.json。\nexport const timeline: FinanceTimeline = timelineData as FinanceTimeline;\n", encoding='utf-8')
    config = renderer / 'tsconfig.json'
    if config.exists():
        value = json.loads(config.read_text(encoding='utf-8'))
        value.setdefault('compilerOptions', {})['resolveJsonModule'] = True
        value['compilerOptions']['allowSyntheticDefaultImports'] = True
        config.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

def patch_template(output):
    adapt_timeline(output)
    patch_visual_primitives(output)
    src = Path(output) / 'renderer/src'
    assets = Path(__file__).parent / 'finance-template-patches'
    scripts = Path(output) / 'renderer/scripts'
    scripts.mkdir(exist_ok=True)
    shutil.copyfile(assets / 'verify-episode.mjs', scripts / 'verify-episode.mjs')
    for name in ['intro-timing.ts', 'safe-visuals.tsx', 'CompanyTitleOverlay.tsx']:
        shutil.copyfile(assets / name, src / name)
    types = src / 'types.ts'
    types.write_text(once(types.read_text(encoding='utf-8'), 'intro?: {src: string; fromFrame?: number; frames?: number; muted: boolean};', 'intro?: {src: string; fromFrame?: number; frames: number; muted: boolean; companyName?: string | null; companyEvidence?: {sceneId: string; field: \'content\' | \'chapter\'; start: number; end: number}};'), encoding='utf-8')
    text = types.read_text(encoding='utf-8')
    text = once(text, 'export type Utterance = {', 'export type Utterance = {\n  speaker?: Speaker;\n  turnId?: string;\n  voiceRef?: string;')
    text = once(text, 'export type DialogueScene = {', "export type DialogueScene = {\n  directing?: {kind: 'speech' | 'visual'; durationSec?: number; visualDirections: string[]};")
    types.write_text(text, encoding='utf-8')
    file = src / 'FinancialDialogue.tsx'
    s = file.read_text(encoding='utf-8')
    s = "import {isIntroFrame} from './intro-timing';\n" + s
    s = once(s, 'durationInFrames={scene.intro.frames ?? 67}', 'durationInFrames={scene.intro.frames!}')
    s = once(s, 'if (scene.intro && frame >= (scene.intro.fromFrame ?? 0)) return <Sequence from={scene.intro.fromFrame ?? 0} durationInFrames={scene.frames - (scene.intro.fromFrame ?? 0)}>', 'if (scene.intro && isIntroFrame(scene, frame)) return <Sequence from={scene.intro.fromFrame ?? 0} durationInFrames={scene.intro.frames!}>')
    s = once(s, '<TemplateMotion {...scene.intro} muted holdLastFrame />', '<TemplateMotion {...scene.intro} muted />')
    s = "import {CompanyTitleOverlay, activeSpeaker} from './CompanyTitleOverlay';\n" + s
    s = once(s, '<TemplateMotion {...scene.intro} muted />', '<TemplateMotion {...scene.intro} muted />\n    <CompanyTitleOverlay name={scene.intro.companyName} />')
    s = once(s, 'speaker={scene.speaker}', 'speaker={activeSpeaker(scene, frame)}')
    file.write_text(s, encoding='utf-8')
    file = src / 'validateTimeline.ts'
    s = file.read_text(encoding='utf-8')
    s = "import {bodyRanges, introRange, isIntroFrame} from './intro-timing';\n" + s
    s = once(s, 'source && !source.intro && e.holdFrame >= source.from', 'source && !isIntroFrame(source, e.holdFrame - source.from) && e.holdFrame >= source.from')
    s = once(s, "if (s.intro) check(typeof s.intro.muted === 'boolean', `${s.id} 视频素材须显式指定 muted`);", "introRange(s);\n    if (s.intro) check(typeof s.intro.muted === 'boolean' && !!s.intro.src?.trim(), `${s.id} 片头须有本地路径并显式指定 muted`);")
    s = once(s, 'if (!s.intro && s.from < bodyUntil) {', 'for (const [bodyStart, bodyStop] of bodyRanges(s, bodyUntil - s.from)) {\n      const bodyUntil = s.from + bodyStop;')
    s = once(s, 'let covered = s.from + (s.chapter?.frames ?? 0);', 'let covered = s.from + bodyStart;')
    # 正文覆盖不再取决于是否填写 ending；不能用片头标记跳过全镜检查。
    s = once(s, 'if (t.ending) {\n          // 只检查真实正文', '{\n          // 只检查真实正文')
    file.write_text(s, encoding='utf-8')

    s = file.read_text(encoding='utf-8')
    s = once(s, "check(utterances.length > 0, '结束记录缺少实际口播');", "// 无口播段仍使用场景真实范围，片尾不要求虚构口播。")
    s = once(s, "check(integer(e.narrationEndFrame) && e.narrationEndFrame === last.scene.from + last.utterance.endFrameExclusive, '全部口播结束帧与实际配音不一致');", "check(integer(e.narrationEndFrame) && (!last || e.narrationEndFrame >= last.scene.from + last.utterance.endFrameExclusive), '片尾不能截断实际配音');")
    s = once(s, "check(finalScene && e.narrationEndFrame > finalScene.from && (finalScene.contentFrames ?? finalScene.frames) === finalEnd - finalScene.from && finalScene.from + finalScene.frames >= finalEnd, '末镜内容长度必须等于完整口播加片尾；仅允许封装补帧');", "check(finalScene && finalScene.from + finalScene.frames === e.narrationEndFrame && finalEnd === t.totalFrames, '末镜结束后完整播放独立片尾');")
    s = once(s, "check(t.scenes.length && end === t.totalFrames, '总帧数与分镜不一致');", "check(t.scenes.length && end + (t.ending?.outro?.frames ?? 0) === t.totalFrames, '总帧数与分镜及片尾不一致');")
    s = once(s, '    let captionEnd = 0;', """    if(s.intro?.companyName != null) check(typeof s.intro.companyName === 'string' && !!s.intro.companyName.trim() && s.intro.companyName.length <= 100, `${s.id} 公司名无效`);
    if(s.directing?.kind === 'visual') check(s.utterances.length === 0 && s.captions.length === 0 && s.directing.visualDirections.length > 0 && Number.isFinite(s.directing.durationSec) && s.frames === Math.ceil(s.directing.durationSec! * t.fps), `${s.id} 无口播画面时长或内容无效`);
    if(s.directing?.kind === 'speech') check(s.utterances.length > 0, `${s.id} 口播缺少配音`);
    let captionEnd = 0;""")
    s = once(s, '    for (const u of s.utterances) {', """    for (const u of s.utterances) {
      check(u.speaker === undefined || u.speaker === 'male-chief' || u.speaker === 'female-host', `${s.id} 句段人物无效`);
      if(s.intro) check(u.endFrameExclusive <= (s.intro.fromFrame ?? 0) || u.startFrame >= (s.intro.fromFrame ?? 0) + s.intro.frames, `${s.id} 片头遮挡口播`);""")
    file.write_text(s, encoding='utf-8')


def patch_visual_primitives(output):
    """维护稳定包装，正文扩展仍由本期作者负责；不把自由场面改成参数菜单。"""
    src = Path(output) / 'renderer/src'
    shutil.copyfile(Path(__file__).parent / 'finance-template-patches/safe-visuals.tsx', src / 'safe-visuals.tsx')
    file = src / 'VisualBlocks.tsx'
    text = file.read_text(encoding='utf-8')
    text = "import {PanelTitle, MetricCard, isVisualFrame} from './safe-visuals';\n" + text
    text = once(text, "frame >= b.startFrame && frame < b.endFrameExclusive", "isVisualFrame(frame, b.startFrame, b.endFrameExclusive)")
    start = text.index("    body = <div style={{...box, width: '100%', textAlign: 'center'}}>")
    end = text.index('    </div>;', start) + len('    </div>;')
    text = text[:start] + "    body = <MetricCard style={box} label={text(p.label)} value={text(p.value)} detail={text(p.detail)} />;" + text[end:]
    start = text.index("    <div style={{position: 'absolute', top: 25, left: 42, right: 42}}>")
    end = text.index('    </div>', start) + len('    </div>')
    text = text[:start] + '    <PanelTitle title={title} label={label} />' + text[end:]
    file.write_text(text, encoding='utf-8')
    # 保留作者显式字幕换行，仍让浏览器处理行宽，已有 LayoutGuard 检查真实高度。
    caption = src / 'SubtitleLayer.tsx'
    caption.write_text(once(caption.read_text(encoding='utf-8'), "whiteSpace: 'normal'", "whiteSpace: 'pre-wrap'"), encoding='utf-8')
    guard = src / 'LayoutGuard.tsx'
    guard.write_text(once(guard.read_text(encoding='utf-8'), '文字溢出：${element.textContent?.slice(0, 40)}', "文字溢出：${element.dataset.layoutObject ?? element.closest('[data-block]')?.getAttribute('data-block') ?? '未命名文字'}：${element.textContent?.slice(0, 40)}"), encoding='utf-8')
