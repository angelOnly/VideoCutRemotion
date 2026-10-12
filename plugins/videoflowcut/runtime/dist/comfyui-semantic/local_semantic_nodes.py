"""本地 MiniCPM-o 视频理解与 Qwen3 文本向量节点。"""

import json
import math
import subprocess
import tempfile
from pathlib import Path

import av
import numpy as np
import torch
import torch.nn.functional as F
from transformers import AutoModel, AutoTokenizer

import folder_paths
import comfy.model_management as model_management


QWEN_REVISION = "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3"
DEFAULT_PROMPT = "请用中文客观描述这段视频中的画面、人物、物体、动作、可见文字、镜头运动，以及可听到的环境声、声音事件和音乐。最后给出检索关键词。只描述实际看到和听到的内容，不确定的内容请明确说明。"


def _model_path(category, name):
    path = Path(folder_paths.models_dir) / category / name
    if not (path / "config.json").is_file():
        raise ValueError(f"本地模型未安装：{path}")
    return str(path)


def _video_path(video):
    root = Path(folder_paths.get_input_directory()).resolve()
    path = Path(folder_paths.get_annotated_filepath(video)).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise ValueError("视频必须是 ComfyUI input 目录内已上传的文件")
    return path


def _audio_content(path, start_seconds, duration_seconds):
    """纯音频保留真实起点与偏移；空窗口不能伪造为静音。"""
    if not math.isfinite(start_seconds) or start_seconds < 0 or not math.isfinite(duration_seconds) or not 0.1 <= duration_seconds <= 30:
        raise ValueError("音频窗口必须是有效的 0.1 到 30 秒")
    with av.open(str(path)) as container:
        if not container.streams.audio:
            raise ValueError("文件没有可解码音轨")
        begin = (container.start_time or 0) / av.time_base + start_seconds
        end = begin + duration_seconds
        container.seek(int(begin * av.time_base), backward=True)
        audio = np.zeros(math.ceil(duration_seconds * 16000), dtype=np.float32)
        resampler = av.AudioResampler(format="fltp", layout="mono", rate=16000)
        written = 0
        def copy_chunk(chunk):
            nonlocal written
            if chunk.time is None:
                raise ValueError("音轨缺少真实时间戳")
            offset = round((chunk.time - begin) * 16000)
            samples = chunk.to_ndarray().reshape(-1)
            left, right = max(0, offset), min(len(audio), offset + len(samples))
            if right > left:
                audio[left:right] = samples[left - offset:right - offset]
                written += right - left
        for frame in container.decode(audio=0):
            if frame.time is not None and frame.time >= end:
                break
            for chunk in resampler.resample(frame):
                copy_chunk(chunk)
        for chunk in resampler.resample(None):
            copy_chunk(chunk)
        if not written:
            raise ValueError("所选窗口没有实际音频数据")
        return audio


def _analyze_media(model, path, kind, prompt, start_seconds, duration_seconds, max_new_tokens):
    if not prompt.strip():
        raise ValueError("分析提示词不能为空")
    python = Path(folder_paths.base_path) / ".minicpmo-runtime" / "Scripts" / "python.exe"
    if not python.is_file():
        raise ValueError("MiniCPM-o 独立运行环境未安装，请按接入文档安装")
    # 模型继续由外部 ComfyUI 队列管理；VideoCut 客户端只调用 HTTP。
    model_management.unload_all_models()
    with tempfile.TemporaryDirectory(prefix="minicpmo-", dir=folder_paths.get_temp_directory()) as directory:
        output = Path(directory) / "result.txt"
        request = {"model": model, "media": str(path), "kind": kind, "prompt": prompt,
                   "start_seconds": start_seconds, "duration_seconds": duration_seconds,
                   "max_new_tokens": max_new_tokens, "output": str(output)}
        process = subprocess.run(
            [str(python), str(Path(__file__).with_name("minicpmo_worker.py"))],
            input=json.dumps(request), capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if process.returncode:
            raise RuntimeError(f"MiniCPM-o 推理失败：{process.stderr.strip().splitlines()[-1] if process.stderr.strip() else process.returncode}")
        text = output.read_text(encoding="utf-8")
    if not text.strip():
        raise ValueError("MiniCPM-o 未返回有效分析文本")
    return {"ui": {"text": [text]}, "result": (text,)}


def _video_content(path, start_seconds, duration_seconds):
    """按真实 PTS 抽取每秒画面，将原音轨对齐到同一时间窗口。"""
    if not math.isfinite(start_seconds) or start_seconds < 0:
        raise ValueError("开始时间必须是非负有限秒数")
    if not math.isfinite(duration_seconds) or not 0 < duration_seconds <= 30:
        raise ValueError("片段时长必须在 0 到 30 秒之间")
    frames = []
    with av.open(str(path)) as container:
        if not container.streams.video:
            raise ValueError("文件没有可解码的视频轨道")
        origin = (container.start_time or 0) / av.time_base
        begin = origin + start_seconds
        end = begin + duration_seconds
        container.seek(int(begin * av.time_base), backward=True)
        next_time = begin
        for frame in container.decode(video=0):
            if frame.time is None or frame.time < next_time:
                continue
            if frame.time >= end:
                break
            frames.append((frame.time - begin, frame.to_image().convert("RGB")))
            next_time = begin + len(frames)
    if not frames:
        raise ValueError("所选时间窗口没有视频画面，请检查开始时间")

    audio = None
    with av.open(str(path)) as container:
        if container.streams.audio:
            audio = np.zeros(math.ceil(duration_seconds * 16000), dtype=np.float32)
            container.seek(int(begin * av.time_base), backward=True)
            resampler = av.AudioResampler(format="fltp", layout="mono", rate=16000)
            for frame in container.decode(audio=0):
                if frame.time is not None and frame.time >= end:
                    break
                for chunk in resampler.resample(frame):
                    if chunk.time is None:
                        raise ValueError("音轨缺少时间戳，无法保证音画同步")
                    offset = round((chunk.time - begin) * 16000)
                    samples = chunk.to_ndarray().reshape(-1)
                    left, right = max(0, offset), min(len(audio), offset + len(samples))
                    if right > left:
                        audio[left:right] = samples[left - offset:right - offset]
            for chunk in resampler.resample(None):
                offset = round((chunk.time - begin) * 16000)
                samples = chunk.to_ndarray().reshape(-1)
                left, right = max(0, offset), min(len(audio), offset + len(samples))
                if right > left:
                    audio[left:right] = samples[left - offset:right - offset]
    content = []
    for index, (_, image) in enumerate(frames):
        content.append(image)
        if audio is not None:
            content.append(audio[index * 16000:min((index + 1) * 16000, len(audio))].copy())
    return content, audio is not None


class LoadLocalMiniCPMO45:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ("MINICPMO45_MODEL",)
    FUNCTION = "load_model"
    CATEGORY = "本地语义分析"

    def load_model(self):
        return (_model_path("VLM", "MiniCPM-o-4_5"),)


class MiniCPMO45AnalyzeVideo:
    @classmethod
    def INPUT_TYPES(cls):
        root = Path(folder_paths.get_input_directory())
        videos = folder_paths.filter_files_content_types([p.name for p in root.iterdir() if p.is_file()], ["video"])
        return {"required": {
            "model": ("MINICPMO45_MODEL",),
            "video": (sorted(videos), {"video_upload": True}),
            "prompt": ("STRING", {"default": DEFAULT_PROMPT, "multiline": True}),
            "start_seconds": ("FLOAT", {"default": 0.0, "min": 0.0, "step": 0.1}),
            "duration_seconds": ("FLOAT", {"default": 5.0, "min": 0.1, "max": 30.0, "step": 0.1}),
            "max_new_tokens": ("INT", {"default": 1024, "min": 16, "max": 4096}),
        }}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("分析文本",)
    FUNCTION = "analyze"
    CATEGORY = "本地语义分析"
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, video, **kwargs):
        return _video_path(video).stat().st_mtime_ns

    @classmethod
    def VALIDATE_INPUTS(cls, video):
        # HTTP 上传放在 input 子目录中，按真实路径验证而非顶层下拉列表。
        try:
            _video_path(video)
        except ValueError as error:
            return str(error)
        return True

    def analyze(self, model, video, prompt, start_seconds, duration_seconds, max_new_tokens):
        return _analyze_media(model, _video_path(video), "video", prompt, start_seconds, duration_seconds, max_new_tokens)


class MiniCPMO45AnalyzeAudio(MiniCPMO45AnalyzeVideo):
    @classmethod
    def INPUT_TYPES(cls):
        inputs = super().INPUT_TYPES()["required"]
        inputs.pop("video")
        files = [p.name for p in Path(folder_paths.get_input_directory()).iterdir() if p.is_file()]
        return {"required": {"audio": (sorted(folder_paths.filter_files_content_types(files, ["audio"])), {"audio_upload": True}), **inputs}}

    @classmethod
    def IS_CHANGED(cls, audio, **kwargs):
        return _video_path(audio).stat().st_mtime_ns

    @classmethod
    def VALIDATE_INPUTS(cls, audio):
        return super().VALIDATE_INPUTS(audio)

    def analyze(self, model, audio, prompt, start_seconds, duration_seconds, max_new_tokens):
        return _analyze_media(model, _video_path(audio), "audio", prompt, start_seconds, duration_seconds, max_new_tokens)


class MiniCPMO45AnalyzeImage(MiniCPMO45AnalyzeVideo):
    @classmethod
    def INPUT_TYPES(cls):
        inputs = super().INPUT_TYPES()["required"]
        for name in ("video", "start_seconds", "duration_seconds"):
            inputs.pop(name)
        files = [p.name for p in Path(folder_paths.get_input_directory()).iterdir() if p.is_file()]
        return {"required": {"image": (sorted(folder_paths.filter_files_content_types(files, ["image"])), {"image_upload": True}), **inputs}}

    @classmethod
    def IS_CHANGED(cls, image, **kwargs):
        return _video_path(image).stat().st_mtime_ns

    @classmethod
    def VALIDATE_INPUTS(cls, image):
        return super().VALIDATE_INPUTS(image)

    def analyze(self, model, image, prompt, max_new_tokens):
        return _analyze_media(model, _video_path(image), "image", prompt, 0, 0, max_new_tokens)


class LoadLocalQwen3Embedding:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ("QWEN3_EMBEDDING_MODEL",)
    FUNCTION = "load_model"
    CATEGORY = "本地语义分析"

    def load_model(self):
        path = _model_path("text_encoders", "Qwen3-Embedding-0.6B")
        tokenizer = AutoTokenizer.from_pretrained(path, local_files_only=True, padding_side="left")
        model = AutoModel.from_pretrained(path, local_files_only=True, torch_dtype=torch.float32).eval()
        return ((model, tokenizer),)


class Qwen3EmbedText:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "model": ("QWEN3_EMBEDDING_MODEL",),
            "texts_json": ("STRING", {"default": '["一只猫在草地上奔跑"]', "multiline": True}),
            "mode": (["document", "query"], {"default": "document"}),
            "instruction": ("STRING", {"default": "Given a video search query, retrieve relevant video descriptions.", "multiline": True}),
        }}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("1024维向量 JSON",)
    FUNCTION = "embed"
    CATEGORY = "本地语义分析"
    OUTPUT_NODE = True

    def embed(self, model, texts_json, mode, instruction):
        texts = json.loads(texts_json)
        if not isinstance(texts, list) or not texts or not all(isinstance(t, str) and t.strip() for t in texts):
            raise ValueError("texts_json 必须是非空字符串数组")
        if mode not in ("document", "query"):
            raise ValueError("mode 必须是 document 或 query")
        if mode == "query":
            if not instruction.strip():
                raise ValueError("查询模式的检索指令不能为空")
            texts = [f"Instruct: {instruction}\nQuery:{text}" for text in texts]
        encoder, tokenizer = model
        vectors = []
        # 小批编码避免大量文本一次填充占用内存；左填充保证最后一个 token 是正文。
        for start in range(0, len(texts), 8):
            tokens = tokenizer(texts[start:start + 8], padding=True, truncation=False, return_tensors="pt")
            if tokens.input_ids.shape[1] > 8192:
                raise ValueError("单条文本超过 8192 token，请分段后编码")
            hidden = encoder(**tokens).last_hidden_state[:, -1]
            vectors.extend(F.normalize(hidden, p=2, dim=1).detach().cpu().tolist())
        result = json.dumps({"model": "Qwen3-Embedding-0.6B", "revision": QWEN_REVISION,
                             "dimensions": 1024, "normalized": True, "embeddings": vectors}, ensure_ascii=False)
        return {"ui": {"text": [result]}, "result": (result,)}


NODE_CLASS_MAPPINGS = {
    "LoadLocalMiniCPMO45": LoadLocalMiniCPMO45,
    "MiniCPMO45AnalyzeVideo": MiniCPMO45AnalyzeVideo,
    "MiniCPMO45AnalyzeAudio": MiniCPMO45AnalyzeAudio,
    "MiniCPMO45AnalyzeImage": MiniCPMO45AnalyzeImage,
    "LoadLocalQwen3Embedding": LoadLocalQwen3Embedding,
    "Qwen3EmbedText": Qwen3EmbedText,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "LoadLocalMiniCPMO45": "加载 MiniCPM-o 4.5 BF16",
    "MiniCPMO45AnalyzeVideo": "MiniCPM-o 视频与原声分析",
    "MiniCPMO45AnalyzeAudio": "MiniCPM-o 纯音频分析",
    "MiniCPMO45AnalyzeImage": "MiniCPM-o 图片与页面分析",
    "LoadLocalQwen3Embedding": "加载 Qwen3-Embedding 0.6B（CPU）",
    "Qwen3EmbedText": "Qwen3 文本编码（1024维）",
}
