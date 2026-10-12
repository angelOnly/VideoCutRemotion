#!/usr/bin/env python3
"""Read-only checks for the delivered art skill. No network or project writes."""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def blob_sha(path: Path) -> str:
    data = path.read_bytes()
    return hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()


def inspect(package: Path, project: Path | None = None) -> dict:
    errors: list[str] = []
    notes: list[str] = []
    config = json.loads((package / "integration-map.json").read_text(encoding="utf-8"))
    payload = package / config["payload_root"]
    manifest_path = package / "file-manifest.json"
    checked = 0
    if not manifest_path.is_file():
        errors.append("Missing file-manifest.json")
    else:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for item in manifest["files"]:
            p = (package / item["path"]).resolve()
            if not p.is_relative_to(package.resolve()):
                errors.append("Unsafe manifest path: " + item["path"])
                continue
            if not p.is_file():
                errors.append("Missing packaged file: " + item["path"])
            elif digest(p) != item["sha256"] or p.stat().st_size != item["bytes"]:
                errors.append("File content differs from manifest: " + item["path"])
            checked += 1
    entries = list(payload.rglob("SKILL.md"))
    if len(entries) != 1:
        errors.append(f"Expected one discoverable SKILL.md; found {len(entries)}")
    target = payload / ".agents/skills/visual-treatment-planning"
    entry = (target / "SKILL.md").read_text(encoding="utf-8")
    if not entry.startswith("---\n"):
        errors.append("Skill YAML frontmatter is absent")
    front = entry.split("---", 2)[1] if entry.startswith("---\n") else ""
    if not re.search(r"^name:\s*visual-treatment-planning\s*$", front, flags=re.M):
        errors.append("Unexpected Skill name")
    if not re.search(r"^description:\s*\S", front, flags=re.M):
        errors.append("Missing description")
    dependencies = set(config["runtime_dependencies"])
    found: set[str] = set()
    local_links = 0
    for p in (target / "SKILL.md", target / "references/art-direction.md"):
        text = p.read_text(encoding="utf-8")
        if any(token in text for token in ("TODO", "待填写", "待补正文")):
            errors.append("Unfinished content in " + p.name)
        for link in re.findall(r"\]\(([^)]+)\)", text):
            if "://" in link or link.startswith("#"):
                continue
            q = (p.parent / link.split("#", 1)[0]).resolve()
            if not q.is_relative_to(payload.resolve()):
                errors.append("Reference escapes payload root: " + link)
                continue
            relative = q.relative_to(payload.resolve()).as_posix()
            if q.is_file():
                local_links += 1
            elif relative in dependencies:
                found.add(relative)
            else:
                errors.append("Undeclared missing reference: " + relative)
    if found != dependencies:
        errors.append("Runtime dependency manifest and skill links differ")
    project_status: dict[str, str] = {}
    missing_deps: list[str] = []
    if project is not None:
        if not project.is_dir():
            errors.append("Project path is not a directory")
        else:
            for dep in sorted(dependencies):
                if not (project / dep).is_file():
                    missing_deps.append(dep)
            for item in config["replace_files"]:
                p = project / item["path"]
                if not p.is_file():
                    state = "missing: locate the current equivalent before integrating"
                elif digest(p) == digest(payload / item["path"]):
                    state = "matches delivered file"
                elif blob_sha(p) == item["baseline_git_blob"]:
                    state = "matches documented source baseline"
                else:
                    state = "differs from baseline: preserve and reconcile local changes"
                project_status[item["path"]] = state
    else:
        notes.append("No user project supplied; dependency existence there is not verified.")
    notes.append("This validates files, not Skill execution, visual quality or video output.")
    return {
        "package_ok": not errors,
        "manifest_files_checked": checked,
        "discoverable_skill_entries": len(entries),
        "in_package_method_links": local_links,
        "declared_existing_project_dependencies": len(dependencies),
        "errors": errors,
        "project_files": project_status,
        "project_missing_dependencies": missing_deps,
        "notes": notes,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--project", type=Path, help="Optional existing VideoFlowCut project root")
    args = parser.parse_args()
    try:
        report = inspect(args.package.resolve(), args.project.resolve() if args.project else None)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 1 if not report["package_ok"] else 2 if report["project_missing_dependencies"] else 0
    except (OSError, ValueError, KeyError, IndexError) as exc:
        print(json.dumps({"package_ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
