"""从已整理的 2.0.11 财经模板生成音色克隆版本。"""
import argparse
import hashlib
import json
import zipfile
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--source', required=True, help='财经模板 2.0.11 ZIP')
parser.add_argument('--output', required=True, help='新版模板 ZIP')
args = parser.parse_args()
source, output = Path(args.source).resolve(), Path(args.output).resolve()
if output.exists():
    raise SystemExit('输出文件已存在，请使用新路径')

with zipfile.ZipFile(source) as original:
    manifest_name = 'renderer/renderer-manifest.json'
    manifest = json.loads(original.read(manifest_name))
    if manifest.get('templateVersion') != '2.0.11' or manifest.get('timelineContract') != 'sentence-timeline/1':
        raise SystemExit('来源不是已整理的财经模板 2.0.11')
    manifest['templateVersion'] = '2.0.12'
    manifest['speakerBindings']['财小策']['voiceRef'] = 'finance.female.01'
    manifest['voiceRefs'] = ['finance.female.01', 'finance.male']
    replacements = {manifest_name: (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode()}
    for name in ('renderer/timeline.json', 'renderer/timeline.example.json'):
        timeline = json.loads(original.read(name))
        # 让实际时间线携带配乐音量，避免被原有显式值覆盖。
        bgm = timeline.setdefault('bgm', {'src': 'template-assets/assets/audio/bgm/immersed.mp3'})
        bgm['volume'] = 0.11
        replacements[name] = (json.dumps(timeline, ensure_ascii=False, indent=2) + '\n').encode()
    for name in ('创作说明.md', '文字分析合同.md'):
        content = original.read(name).decode('utf-8').replace('finance.female', 'finance.female.01')
        if name == '创作说明.md':
            content += '\n新版模板使用女声01，配乐初始音量为 0.11，制作时结合对白试听调整。\n'
        replacements[name] = content.encode('utf-8')
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'w') as result:
        for info in original.infolist():
            result.writestr(info, replacements.get(info.filename, original.read(info.filename)))

print(json.dumps({'zip': str(output), 'bytes': output.stat().st_size,
                  'sha256': hashlib.sha256(output.read_bytes()).hexdigest()}, ensure_ascii=False))
