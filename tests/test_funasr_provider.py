"""直接核验发行 wheel 中的真实函数，不导入 GPU 模型，也不使用模拟实现。"""

import ast
import hashlib
import importlib.util
import itertools
import json
import logging
from pathlib import Path
import re
import unittest
import zipfile


ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "plugins/videoflowcut/scripts/build-funasr-provider.py"
DIST = ROOT / "plugins/videoflowcut/runtime/dist/providers"


class FunASRProviderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        manifest = json.loads((DIST / "funasr.json").read_text(encoding="utf-8"))
        wheel = (DIST / manifest["wheel"]).read_bytes()
        assert hashlib.sha256(wheel).hexdigest() == manifest["sha256"]
        with zipfile.ZipFile(DIST / manifest["wheel"]) as archive:
            cls.auto_source = archive.read("funasr/auto/auto_model.py").decode("utf-8")
            cls.timestamp_source = archive.read("funasr/utils/timestamp_tools.py").decode("utf-8")
        cls.env = {"re": re, "logging": logging, "zip_longest": itertools.zip_longest}
        for source, name in [(cls.auto_source, "_join_vad_texts"), (cls.timestamp_source, "timestamp_sentence")]:
            function = next(n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name == name)
            exec(compile(ast.Module(body=[function], type_ignores=[]), "release_function", "exec"), cls.env)

    def test_alignment_uses_original_token_boundaries(self):
        tree = ast.parse(self.auto_source)
        assignments = [n for n in ast.walk(tree) if isinstance(n, ast.Assign)
                       and any(isinstance(t, ast.Name) and t.id == "timestamp_text" for t in n.targets)]
        self.assertTrue(any(isinstance(n.value, ast.Name) and n.value.id == "raw_text" for n in assignments))
        self.assertFalse(any(isinstance(n.value, ast.Name) and n.value.id == "punc_input_text" for n in assignments))

    def test_multiple_chinese_chunks_do_not_shift_punctuation_or_time(self):
        parts = ["今 天 我 们", "继 续 剪 辑", "视 频 真 好"]
        raw = " ".join(parts)
        stamps = [[i * 100, (i + 1) * 100] for i in range(12)]
        result = self.env["timestamp_sentence"]([1, 1, 1, 3] * 3, stamps, raw, True)
        self.assertEqual([s["text"] for s in result], ["今天我们。", "继续剪辑。", "视频真好。"])
        self.assertEqual([(s["start"], s["end"]) for s in result], [(0, 400), (400, 800), (800, 1200)])
        self.assertEqual([stamp for s in result for stamp in s["timestamp"]], stamps)

    def test_old_display_join_is_rejected_instead_of_fabricating_punctuation_card(self):
        joined = self.env["_join_vad_texts"](["今 天 我 们", "继 续 剪 辑"])
        self.assertEqual(len(joined.split()), 7)
        with self.assertRaisesRegex(ValueError, "token"):
            self.env["timestamp_sentence"]([1, 1, 1, 3, 1, 1, 2, 3], [[i, i + 1] for i in range(8)], joined)

    def test_english_and_mixed_tokens_keep_provider_times(self):
        stamps = [[0, 80], [100, 210], [250, 400], [430, 510]]
        result = self.env["timestamp_sentence"]([1, 3, 1, 3], stamps, "Hello world 视 频")
        self.assertEqual([s["text"].strip() for s in result], ["Hello world。", "视频。"])
        self.assertEqual([s["timestamp"] for s in result], [stamps[:2], stamps[2:]])

    def test_build_refuses_different_upstream(self):
        spec = importlib.util.spec_from_file_location("provider_build", BUILD)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with self.assertRaisesRegex(ValueError, "SHA256"):
            module.build(b"different wheel")
        with self.assertRaises(ValueError):
            module.replace_once("same same", "same", "replacement")


if __name__ == "__main__":
    unittest.main()
