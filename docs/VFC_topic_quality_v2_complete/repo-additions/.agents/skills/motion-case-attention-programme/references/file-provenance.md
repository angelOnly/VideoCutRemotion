# 案例文件来源：已经生成的文件与原件的对应

本表说明每份文件是原样复制、字段提取、视频抽帧，还是本轮编写。机器可读的完整路径与SHA-256见 [artifact-provenance.json](../source/artifact-provenance.json)。它们不是下载清单：本目录中列出的文件已经整理好。

**原包根 Z：** `video22_attention_final_only/`（位于用户上传的同名zip中）。

**固定动效目录 M：** `Z/项目文件/assets/derived/motion/job_583ad089-c51f-46be-9cae-f5602860c55f/d79f246c0825a9cb562171e5ed6335a371ad059820b54f43e26afcdba7886396/`。

| 案例文件 | 来源/生成方式 | 它的身份 |
|---|---|---|
| `assets/preview.mp4` | Z/项目文件/exports/revision-72/delivery-export_artifact_d3df428b-cb9e-4cf9-b23d-a6644f5830e4.mp4，原样复制 | 用户认可的最终片，非参考作者原片 |
| `references/original-input.md` | Z/方案文档/02_attention_new_generation.md，原样复制 | 当时收到的完整指令，不是本轮重写 |
| `source/source.json` / `manifest.json` | M内同名文件，原样复制 | 最终v3固定输入与版本清单 |
| `source/Motion.tsx` | source.json的source字段，字符串原样提取 | 真实最终源码，不是另写的演示程序 |
| `source/props.json` | source.json的props字段 | 真实最终几何、ROI、步骤与时序参数 |
| `references/submitted-brief.md` | source.json的creativeBrief字段 | 原样提交摘要，不等于完整原导演对话 |
| `source/timing.json` | props.events、lensNodes、fps提取，秒数=帧/fps | 历史作品事件，不是字幕逐词时间 |
| `source/font-bindings.json` | source.json字体槽＋manifest.boundFonts | 字体身份/字重/hash，不包含字体文件 |
| `source/materials.json` | manifest.boundImages/boundVideos＋图像原manifest＋打包说明 | 真实材料角色、原路径、源区间与缺口 |
| `assets/materials/*.jpg` | 按boundImages指向的三份图片复制，并核对hash | 原图字节与EXIF保留；不是新生图 |
| `assets/audio/speech-2.wav` | Z/项目文件/assets/speech/speech-2.wav原样复制 | 包内完整WAV，26.280秒；不冒充混音后AAC |
| `assets/keyframes/f*.jpg` | 从最终preview.mp4按明确帧号抽取 | 本轮新提取的真实帧，非新动画、非历史审片原件 |
| `assets/keyframes/contact-sheet.jpg` | 14张上述帧等比排在一张阅读图上 | 阅读辅助，不证明动态 |
| `source/production-run.json` | Z/项目文件/reports/production-run-production_run_d934dcad-ef12-4cf2-bef9-1b1c296cf0f0.json原样复制 | 原生产记录，没有改写其中待审状态 |
| `references/adopted-design.md` | 本轮读报告、提交摘要与源码后整理 | 复原性说明；不伪装缺失的完整原采用稿 |
| `references/design-decisions.md` | 本轮针对具体函数、事件与真实帧写分析 | 教学解释，不是独立因果验证 |
| `references/revisions-and-limits.md` | 从原报告和打包说明归纳，保留缺口 | 历史修订＋实际验证边界 |
| `references/user-feedback.md` | 记录用户上传本包后的原话“这次视频效果可以了” | 后续反馈，不回写原报告 |
| `references/transfer-guide.md` | 本轮编写 | 无参考主题的迁移教学，尚无自己的新视频 |
| `SKILL.md` / `agents/openai.yaml` | 本轮按当前项目案例结构编写 | 完整新增案例入口与显示元数据，不是新增代理 |
| `case-record.json` | 本轮汇总实际文件身份、反馈和缺口 | 资料清单，不是项目API字段 |

## 小包没有的，不在本目录里假造
两份原大视频、字体原件、完整最终字幕卡和对齐、完整最终导演稿、v1/v2源码以及首版R49视频未附。它们的恢复路径见 [materials-and-replay.md](materials-and-replay.md)。仅为学习本例无需先恢复全部旧依赖。
