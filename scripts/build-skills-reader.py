"""从唯一 Skills 源生成本地阅读页，不维护另一套正文。"""
from pathlib import Path
import hashlib
import html
import json
import re
import importlib.util

try:
    import mistune
except ImportError:
    raise SystemExit('生成阅读页需要当前 Python 环境中的 mistune；已有 HTML 可直接打开阅读。')

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / '.agents' / 'skills'
OUTPUT = ROOT / 'docs' / 'Skills阅读.html'


def heading_id(text):
    return re.sub(r'[^\w\-\s\u3400-\u9fff]', '', re.sub(r'<[^>]+>|[`*_]', '', text).lower()).replace(' ', '-')


class Renderer(mistune.HTMLRenderer):
    def heading(self, text, level, **attrs):
        return f'<h{level} id="{html.escape(heading_id(text), quote=True)}">{text}</h{level}>\n'


def build():
    markdown = mistune.create_markdown(renderer=Renderer(escape=True), plugins=['table', 'strikethrough', 'url'])
    roles = json.loads((ROOT / 'scripts/skills-reader-navigation.json').read_text(encoding='utf-8'))
    skill_names = {key: name for role in roles for key, name in role['skills']}
    skill_names['motion-case-library'] = '案例检索与参考'
    actual = {p.parent.name for p in SOURCE.glob('*/SKILL.md')}
    if actual != set(skill_names):
        raise SystemExit(f'中文导航与工作入口不一致：{actual ^ set(skill_names)}')
    directory_names = {'_shared': '共同方法与交接约定', 'references': '详细方法与参考', 'scripts': '计算脚本', 'agents': '调用配置', 'assets': '媒体原件', 'source': '实现源码与绑定', 'cases': '完整案例', 'keyframes': '关键画面', 'materials': '采用素材', 'audio': '声音原件'}
    directory_names['source-records'] = '原始制作记录'
    for index, name in enumerate(sorted({p.name for p in SOURCE.rglob('job_*') if p.is_dir()}), 1):
        directory_names[name] = f'原始任务记录 {index:02d}'
    labels = {'SKILL.md': '工作入口', 'CASE.md': '案例完整说明', 'openai.yaml': '代理调用配置', 'original-agent-config.yaml': '原代理配置存档', 'Motion.tsx': '完整动画源码', 'motion.tsx': '动画源码', 'source.tsx': '原始实现源码', 'before-motion.tsx': '修订前动画源码', 'case-record.json': '案例记录', 'source.json': '原始提交内容', 'font-bindings.json': '字体绑定', 'materials.json': '素材绑定与来源', 'keyframes.json': '关键帧记录', 'integrity.json': '原件完整性记录', 'manifest.json': '资源清单', 'fixture.json': '测试输入', 'attribution-original.json': '原始来源记录', 'original-request.txt': '原始制作要求', 'material-math.mjs': '坐标与时间计算', 'material-math.test.mjs': '坐标与时间回归验证', 'preview.mp4': '案例视频', 'observed-full.mp4': '完整观察视频', 'observed-preview.mp4': '观察预览视频', 'before.mp4': '修订前视频', 'speech-2.wav': '旁白原件', 'contact-sheet.jpg': '关键画面总览', 'art.jpg': '美术素材', 'chair.jpg': '座椅素材', 'identity.jpg': '身份素材', 'paper.jpg': '纸张素材'}
    title_changes = {'Project、Revision、Skill 交接与执行安全': '项目、版本与角色交接', 'B-roll、Cutaway 与主画面交接': '辅助镜头与主画面交接', 'Draft、Delivery 与最终文件': '草稿、交付与最终文件', 'Presenter、Explainer、Vlog 模式专项审片 Rubric': '三种视频路线的专项审片标准', 'VideoFlowCut Remotion 组件与 Registry 合同': '受管动画组件与资源合同', 'Scene 规划、边界和内部状态': '场面规划、边界与内部状态', 'Scene类型、范围与写入': '场面类型、范围与写入', 'Script操作与失效范围': '文稿操作与影响范围', '人物生成、Mask与声音所有权': '人物生成、遮罩与声音归属', '声音与Bridge工作流故障': '声音服务与工作流故障', '项目写入、Job、读回与恢复': '项目提交、任务状态与恢复', '事件、起音与音频Item映射': '事件、起音与音频片段对应', 'r92混合场面案例组': '混合场面案例组', 'SIM 群体 → 手机页面 → 撕纸 → 使用场景': '卡片群体、手机页面、撕纸与使用场景', 'SIM 群体 → QCI 页面 → 时钟拨针：三段顺滑接力': '卡片群体、术语页面与时钟接力'}
    files = []
    for path in sorted(SOURCE.rglob('*')):
        if not path.is_file():
            continue
        relative = path.relative_to(SOURCE).as_posix()
        raw = path.read_bytes()
        item = {'path': relative, 'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
        if path.suffix.lower() in {'.md', '.json', '.yaml', '.yml', '.tsx', '.ts', '.mjs', '.txt'}:
            text = raw.decode('utf-8-sig')
            item['source'] = text
            if path.suffix == '.md':
                # 元数据另行折叠，正文完整渲染；历史资料中的 HTML 作为文字显示。
                match = re.match(r'^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)', text)
                body = text[match.end():] if match else text
                item['html'] = (f'<details><summary>文件元数据</summary><pre>{html.escape(match[0])}</pre></details>' if match else '') + markdown(body)
                title = re.search(r'^# (.+)', body, re.M)
                item['title'] = title.group(1) if title else path.name
            else:
                item['html'] = '<pre><code>' + html.escape(text) + '</code></pre>'
        item['label'] = labels.get(path.name, title_changes.get(item.get('title'), item.get('title')))
        if path.name == 'SKILL.md':
            item['label'] = skill_names.get(path.parent.name, '工作入口')
        if not item['label'] or not re.search(r'[\u3400-\u9fff]', item['label']):
            stem = path.stem
            subject = {'clock': '时钟', 'sim': '卡片群体', 'qci': '术语页面', 'phone': '手机', 'tower': '信号塔'}.get(stem.removeprefix('before-'))
            if subject:
                item['label'] = ('修订前' if stem.startswith('before-') else '') + subject + ('视频' if path.suffix == '.mp4' else '源码')
            elif re.match(r'(?:f|preview-|observed-)\d+$', stem):
                item['label'] = ('观察画面 ' if stem.startswith('observed') else '关键画面 ') + re.search(r'\d+', stem)[0]
            else:
                item['label'] = '参考说明' if path.suffix == '.md' else '原始资源'
        if path.name == 'CASE.md':
            directory_names[path.parent.name] = item['label']
        files.append(item)
    # 转义脚本边界，正文不会作为页面脚本执行。
    data = json.dumps(files, ensure_ascii=False).replace('&', '\\u0026').replace('<', '\\u003c').replace('>', '\\u003e').replace('\u2028', '\\u2028').replace('\u2029', '\\u2029')
    template = (ROOT / 'scripts' / 'skills-reader.html').read_text(encoding='utf-8')
    cards = []
    for index, role in enumerate(roles, 1):
        links = ' · '.join(f'[{name}]({key}/SKILL.md)' for key, name in role['skills'])
        cards.append(f'### {index:02d} {role["name"]}\n\n{role["duty"]}\n\n**交回什么：** {role["result"]}。\n\n**对应资料：** {links}')
    guide = (ROOT / 'scripts/skills-reader-guide.md').read_text(encoding='utf-8').replace('__ROLE_CARDS__', '\n\n'.join(cards))
    navigation = {'roles': roles, 'names': {**directory_names, **skill_names}, 'guide': markdown(guide)}
    nav_data = json.dumps(navigation, ensure_ascii=False).replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')
    spec = importlib.util.spec_from_file_location('skills_comparison', ROOT / 'scripts/build-skills-comparison.py')
    comparison_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(comparison_module)
    comparison = comparison_module.build_comparison(ROOT, files, markdown)
    comparison_data = json.dumps(comparison, ensure_ascii=False).replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026').replace('\u2028', '\\u2028').replace('\u2029', '\\u2029')
    comparison_script = (ROOT / 'scripts/skills-reader-comparison.js').read_text(encoding='utf-8')
    OUTPUT.write_text(template.replace('__SKILLS_DATA__', data).replace('__NAVIGATION_DATA__', nav_data).replace('__COMPARISON_DATA__', comparison_data).replace('__COMPARISON_SCRIPT__', comparison_script), encoding='utf-8')
    print(f'{OUTPUT}\n已生成 {len(files)} 个文件的目录，正文来自 .agents/skills。')


if __name__ == '__main__':
    build()
