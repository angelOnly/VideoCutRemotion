"""从现有视频应用创建原生音频/图片 HTTP 应用，使用 Bridge 自身指纹算法。"""
import argparse
import copy
import json
import sys
import uuid
import hashlib
import shutil
from datetime import datetime
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--comfy-root", type=Path, required=True)
    parser.add_argument("--install-nodes", action="store_true", help="备份并安装仓库内外部节点；不会安装模型或自动重启 ComfyUI")
    parser.add_argument("--nodes-only", action="store_true", help="只安装已构建节点，不改写已有工作流")
    args = parser.parse_args()
    if args.nodes_only and not args.install_nodes:
        parser.error("--nodes-only 必须与 --install-nodes 一起使用")
    root = args.comfy_root.resolve()
    if args.install_nodes:
        bundle = Path(__file__).resolve().parents[1] / "plugins/videoflowcut/runtime/dist/comfyui-semantic"
        if not all((bundle / name).is_file() for name in ("local_semantic_nodes.py", "minicpmo_worker.py")):
            raise RuntimeError("请先构建包含语义节点的正式发行产物")
        target = root / "custom_nodes/Comfyui-AppApi"
        entry = target / "__init__.py"
        if not entry.is_file() or "SEMANTIC_NODE_CLASS_MAPPINGS" not in entry.read_text(encoding="utf-8"):
            raise RuntimeError("外部 Comfyui-AppApi 必须已注册语义节点模块，本脚本不改写第三方注册入口")
        backup = target / "semantic-backups" / datetime.now().strftime("%Y%m%d-%H%M%S")
        backup.mkdir(parents=True, exist_ok=False)
        for name in ("local_semantic_nodes.py", "minicpmo_worker.py"):
            source = bundle / name
            if (target / name).is_file():
                shutil.copy2(target / name, backup / name)
            shutil.copy2(source, target / name)
            print(json.dumps({"installed": name, "sha256": hashlib.sha256(source.read_bytes()).hexdigest(), "backup": str(backup)}, ensure_ascii=False))
        if args.nodes_only:
            return
    sys.path.insert(0, str(root))
    sys.path.insert(0, str(root / "custom_nodes" / "Comfyui-AppApi"))
    from workflow_catalog import compute_fingerprint
    directory = root / "user/default/workflows/本地语义分析"
    template = json.loads((directory / "MiniCPM-o 4.5 视频原声分析.app.json").read_text(encoding="utf-8"))
    for kind, title, node_type in [("audio", "纯音频分析", "MiniCPMO45AnalyzeAudio"), ("image", "图片与页面分析", "MiniCPMO45AnalyzeImage")]:
        workflow = copy.deepcopy(template)
        old_id = workflow["id"]
        workflow_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"videoflowcut/local-semantic/{kind}/v1"))
        # 引用 ID 与文件槽位统一修改，仍保留原模型加载节点和输出类型。
        workflow = json.loads(json.dumps(workflow, ensure_ascii=False).replace(old_id, workflow_id).replace("MiniCPMO45AnalyzeVideo", node_type))
        workflow["id"] = workflow_id
        workflow["extra"]["name"] = f"MiniCPM-o 4.5 {title}"
        node = workflow["nodes"][1]
        for entry in node["inputs"]:
            if entry["name"] == "video":
                entry["name"] = kind
                entry["widget"]["name"] = kind
        named = node["widgets_values_named"]
        named[kind] = named.pop("video")
        snapshot = workflow["extra"]["comfyuiBridge"]
        api_inputs = snapshot["apiPrompt"]["2"]["inputs"]
        api_inputs[kind] = api_inputs.pop("video")
        for mapping in snapshot["inputMappings"]:
            if mapping["id"] == "video":
                mapping.update(id=kind, inputName=kind, label=kind, kind=kind, widgetRef=f"{workflow_id}:2:{kind}")
        linear = workflow["extra"]["linearData"]["inputs"]
        linear[0] = [f"{workflow_id}:2:{kind}", kind]
        if kind == "image":
            removed = {"start_seconds", "duration_seconds"}
            node["inputs"] = [entry for entry in node["inputs"] if entry["name"] not in removed]
            for key in removed:
                named.pop(key, None)
                api_inputs.pop(key, None)
            snapshot["inputMappings"] = [entry for entry in snapshot["inputMappings"] if entry["id"] not in removed]
            workflow["extra"]["linearData"]["inputs"] = [entry for entry in linear if entry[1] not in removed]
        order = [kind, "prompt"] + (["start_seconds", "duration_seconds"] if kind == "audio" else []) + ["max_new_tokens"]
        node["widgets_values"] = [named[key] for key in order]
        snapshot["sourceFingerprint"] = compute_fingerprint(workflow)
        path = directory / f"MiniCPM-o 4.5 {title}.app.json"
        path.write_text(json.dumps(workflow, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"kind": kind, "workflowId": workflow_id, "path": str(path)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
