"""由目标 ComfyUI Python 显式执行，安装/核验发行包；不升级其它依赖。"""

import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import subprocess
import sys


def verify(manifest):
    distribution = importlib.metadata.distribution("funasr")
    if distribution.version != manifest["version"]:
        raise ValueError(f"FunASR 版本不一致：{distribution.version}")
    for relative, digest in manifest["sources"].items():
        source = Path(distribution.locate_file(relative))
        if hashlib.sha256(source.read_bytes()).hexdigest() != digest:
            raise ValueError(f"FunASR 已安装源码与发行物不一致：{relative}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--distribution", type=Path, required=True)
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args()
    provider = args.distribution.resolve() / "providers"
    manifest = json.loads((provider / "funasr.json").read_text(encoding="utf-8"))
    wheel = provider / manifest["wheel"]
    if wheel.parent != provider or hashlib.sha256(wheel.read_bytes()).hexdigest() != manifest["sha256"]:
        raise ValueError("FunASR 发行文件路径或 SHA256 校验失败")
    if not args.check_only:
        subprocess.run([sys.executable, "-m", "pip", "install", "--no-deps", "--no-index",
                        "--disable-pip-version-check", "--force-reinstall", str(wheel)], check=True)
    verify(manifest)
    print(json.dumps({"python": sys.executable, "version": manifest["version"], "verified": True}))
