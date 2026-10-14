# 媒体阶段计时报告

这是实际日志覆盖的观测区间；未埋点的排队、回调或人工等待不在统计内。阶段存在父子与并行重叠，禁止把各阶段覆盖时间相加作为端到端耗时。

资源字段仅反映 Node 进程（含同进程并发工作，不含浏览器与 FFmpeg 子进程）；RSS 峰值为进程生命周期峰值，I/O 等待未采集。主机空闲内存与进程可用内存分别记录，不能推断全部媒体进程资源瓶颈。

## Run 00000000-0000-4000-8000-000000000002 / 请求 fixed-render

- 源码摘要：8243842ccb91a5e476be1115ac8b559ab900907fe1b124cdcc27f6cb250f485e
- 观测墙钟：27.649 秒
- 去重覆盖：27.649 秒
- 时钟：同进程单调时钟

| 阶段 | 次数 | 去重覆盖（秒） | 成功 | 失败 | 取消 |
|---|---:|---:|---:|---:|---:|
| freeze_project | 1 | 0.016 | 1 | 0 | 0 |
| template_validation | 1 | 0.003 | 1 | 0 | 0 |
| bundle | 1 | 17.503 | 1 | 0 | 0 |
| prepare | 1 | 17.508 | 1 | 0 | 0 |
| select_composition | 1 | 2.012 | 1 | 0 | 0 |
| render_media | 1 | 6.545 | 1 | 0 | 0 |
| video_ffprobe | 3 | 0.597 | 3 | 0 | 0 |
| video_full_decode | 3 | 0.449 | 3 | 0 | 0 |
| video_validation | 1 | 0.496 | 1 | 0 | 0 |
| file_record_sha | 3 | 0.001 | 3 | 0 | 0 |
| scene_accurate | 2 | 0.491 | 2 | 0 | 0 |
| scene_slice | 2 | 1.049 | 2 | 0 | 0 |
| benchmark_render_total | 1 | 27.649 | 1 | 0 | 0 |

## Run 00000000-0000-4000-8000-000000000004 / 请求 fixed-render

- 源码摘要：8243842ccb91a5e476be1115ac8b559ab900907fe1b124cdcc27f6cb250f485e
- 观测墙钟：22.795 秒
- 去重覆盖：22.795 秒
- 时钟：同进程单调时钟

| 阶段 | 次数 | 去重覆盖（秒） | 成功 | 失败 | 取消 |
|---|---:|---:|---:|---:|---:|
| freeze_project | 1 | 0.015 | 1 | 0 | 0 |
| template_validation | 1 | 0.003 | 1 | 0 | 0 |
| bundle | 1 | 13.448 | 1 | 0 | 0 |
| prepare | 1 | 13.453 | 1 | 0 | 0 |
| select_composition | 1 | 1.884 | 1 | 0 | 0 |
| render_media | 1 | 5.889 | 1 | 0 | 0 |
| video_ffprobe | 3 | 0.558 | 3 | 0 | 0 |
| video_full_decode | 3 | 0.465 | 3 | 0 | 0 |
| video_validation | 1 | 0.431 | 1 | 0 | 0 |
| file_record_sha | 3 | 0.001 | 3 | 0 | 0 |
| scene_accurate | 2 | 0.499 | 2 | 0 | 0 |
| scene_slice | 2 | 1.100 | 2 | 0 | 0 |
| benchmark_render_total | 1 | 22.795 | 1 | 0 | 0 |

## Run 00000000-0000-4000-8000-000000000006 / 请求 fixed-render

- 源码摘要：8243842ccb91a5e476be1115ac8b559ab900907fe1b124cdcc27f6cb250f485e
- 观测墙钟：21.565 秒
- 去重覆盖：21.565 秒
- 时钟：同进程单调时钟

| 阶段 | 次数 | 去重覆盖（秒） | 成功 | 失败 | 取消 |
|---|---:|---:|---:|---:|---:|
| freeze_project | 1 | 0.016 | 1 | 0 | 0 |
| template_validation | 1 | 0.003 | 1 | 0 | 0 |
| bundle | 1 | 12.774 | 1 | 0 | 0 |
| prepare | 1 | 12.779 | 1 | 0 | 0 |
| select_composition | 1 | 1.628 | 1 | 0 | 0 |
| render_media | 1 | 5.550 | 1 | 0 | 0 |
| video_ffprobe | 3 | 0.567 | 3 | 0 | 0 |
| video_full_decode | 3 | 0.477 | 3 | 0 | 0 |
| video_validation | 1 | 0.446 | 1 | 0 | 0 |
| file_record_sha | 3 | 0.002 | 3 | 0 | 0 |
| scene_accurate | 2 | 0.512 | 2 | 0 | 0 |
| scene_slice | 2 | 1.119 | 2 | 0 | 0 |
| benchmark_render_total | 1 | 21.565 | 1 | 0 | 0 |

基准比较必须固定源码摘要、输入素材、画幅、帧率、帧数、编码参数、并发配置及环境，并分别保存基线与候选日志。摘要相同本身不能证明其他条件相同；本工具不自动宣称加速或判断瓶颈。
