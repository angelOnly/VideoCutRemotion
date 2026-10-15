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
    src = Path(output) / 'renderer/src'
    assets = Path(__file__).parent / 'finance-template-patches'
    for name in ['intro-timing.ts', 'safe-visuals.tsx']:
        shutil.copyfile(assets / name, src / name)
    types = src / 'types.ts'
    types.write_text(once(types.read_text(encoding='utf-8'), 'intro?: {src: string; fromFrame?: number; frames?: number; muted: boolean};', 'intro?: {src: string; fromFrame?: number; frames: number; muted: boolean};'), encoding='utf-8')
    file = src / 'FinancialDialogue.tsx'
    s = file.read_text(encoding='utf-8')
    s = "import {isIntroFrame} from './intro-timing';\n" + s
    s = once(s, 'durationInFrames={scene.intro.frames ?? 67}', 'durationInFrames={scene.intro.frames!}')
    s = once(s, 'if (scene.intro && frame >= (scene.intro.fromFrame ?? 0)) return <Sequence from={scene.intro.fromFrame ?? 0} durationInFrames={scene.frames - (scene.intro.fromFrame ?? 0)}>', 'if (scene.intro && isIntroFrame(scene, frame)) return <Sequence from={scene.intro.fromFrame ?? 0} durationInFrames={scene.intro.frames!}>')
    s = once(s, '<TemplateMotion {...scene.intro} muted holdLastFrame />', '<TemplateMotion {...scene.intro} muted />')
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
