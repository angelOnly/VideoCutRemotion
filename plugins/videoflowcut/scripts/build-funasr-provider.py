"""从固定上游 wheel 构建可追溯的 FunASR 修正版；不接触已安装 Python 环境。"""

import base64
import csv
import hashlib
import io
import json
from pathlib import Path
import urllib.request
import zipfile


UPSTREAM_VERSION = "1.4.6"
VERSION = "1.4.6+videoflowcut.1"
UPSTREAM_URL = "https://files.pythonhosted.org/packages/b9/d6/049887b6608a77b0c7a24cffa60f777b2e27b0d5ffc2311d5288d5cc4d04/funasr-1.4.6-py3-none-any.whl"
UPSTREAM_SHA256 = "f63f8fdb70738c242f3f5a95fdff1c34e366891eb0a2af0fa586dd4b182dfb4e"
DIST = Path(__file__).resolve().parents[1] / "runtime" / "dist" / "providers"
AUTOMODEL = "funasr/auto/auto_model.py"
TIMESTAMPS = "funasr/utils/timestamp_tools.py"


def replace_once(source, before, after):
    if source.count(before) != 1:
        raise ValueError("上游源码与已审查基线不同，停止构建，不能猜测应用修正")
    return source.replace(before, after, 1)


def repair_sources(files):
    source = files[AUTOMODEL].decode("utf-8")
    # 标点模型使用可读文本，但时间对齐必须继续使用 ASR 原有的空格 token 边界。
    # 不能将 _join_vad_texts 去掉块间空格的展示文本喂给按 split() 对齐的函数。
    source = replace_once(source, "            timestamp_text = punc_input_text\n",
        "            # 时间对齐保留 ASR token 边界；展示文本会合并中文块间空格。\n"
        "            timestamp_text = raw_text\n")
    files[AUTOMODEL] = source.encode("utf-8")
    source, separator, english_source = files[TIMESTAMPS].decode("utf-8").partition("def timestamp_sentence_en(")
    if not separator:
        raise ValueError("上游字幕时间函数边界变化，停止构建")
    # zip_longest 会把缺失文字补成 None，制造有时间但只有标点的伪字幕；必须前置拒绝。
    anchor = "    texts = text_postprocessed.split()\n    punc_stamp_text_list = list(\n"
    source = replace_once(source, anchor,
        "    texts = text_postprocessed.split()\n"
        "    if not (len(texts) == len(timestamp_postprocessed) == len(punc_id_list)):\n"
        "        raise ValueError(\"FunASR 字幕的 token、标点与时间数量不一致；拒绝错位对齐\")\n"
        "    punc_stamp_text_list = list(\n")
    files[TIMESTAMPS] = (source + separator + english_source).encode("utf-8")


def build(upstream):
    if hashlib.sha256(upstream).hexdigest() != UPSTREAM_SHA256:
        raise ValueError("上游 FunASR wheel 的 SHA256 不匹配，停止构建")
    with zipfile.ZipFile(io.BytesIO(upstream)) as archive:
        files = {name: archive.read(name) for name in archive.namelist() if not name.endswith("/")}
    repair_sources(files)
    old_info = f"funasr-{UPSTREAM_VERSION}.dist-info/"
    new_info = f"funasr-{VERSION}.dist-info/"
    files = {name.replace(old_info, new_info): data for name, data in files.items()}
    metadata = files[new_info + "METADATA"].decode("utf-8")
    files[new_info + "METADATA"] = replace_once(metadata, f"Version: {UPSTREAM_VERSION}\n", f"Version: {VERSION}\n").encode("utf-8")
    # 包内版本须与 pip 元数据一致，避免运行日志仍把修正版标成旧版。
    version_file = "funasr/version.txt"
    if version_file in files:
        files[version_file] = (VERSION + "\n").encode("utf-8")
    record_path = new_info + "RECORD"
    files.pop(record_path)
    records = io.StringIO(newline="")
    writer = csv.writer(records, lineterminator="\n")
    for name, data in sorted(files.items()):
        digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode("ascii")
        writer.writerow([name, "sha256=" + digest, len(data)])
    writer.writerow([record_path, "", ""])
    files[record_path] = records.getvalue().encode("utf-8")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(files.items()):
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o644 << 16
            archive.writestr(entry, data)
    wheel = buffer.getvalue()
    manifest = {
        "name": "funasr", "version": VERSION,
        "wheel": f"funasr-{VERSION}-py3-none-any.whl",
        "sha256": hashlib.sha256(wheel).hexdigest(),
        "upstreamUrl": UPSTREAM_URL, "upstreamSha256": UPSTREAM_SHA256,
        "sources": {path: hashlib.sha256(files[path]).hexdigest() for path in (AUTOMODEL, TIMESTAMPS)},
    }
    return wheel, manifest


if __name__ == "__main__":
    with urllib.request.urlopen(UPSTREAM_URL, timeout=60) as response:
        wheel, manifest = build(response.read())
    DIST.mkdir(parents=True, exist_ok=True)
    (DIST / manifest["wheel"]).write_bytes(wheel)
    (DIST / "funasr.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=True))
