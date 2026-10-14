---
name: motion-case-library
description: 视觉作者按需词法检索并核读运动机制，用于新建或重构运动关系。
---

# motion-case-library

只有新建或实质重构运动关系时使用 search_motion_mechanisms；首次通常取 3 个候选，再核读真正入围的 1～2 项。围绕“哪个对象保持、哪种关系改变、如何进入与退出”描述查询；已有 ID 直接定位，沿来源指纹核查。

read_motion_mechanism 默认只读机制正文，需要判断空间运动时显式 include_storyboard=true。静态分镜不能证明连续速度或声音效果。工具只提供本地词法机制，不打开整片概览、历史作品或外部模型。

采用记录放在当前演出稿：ID、source_sha256、本片对象映射、保留和舍弃动作、实际观察范围。无结果先调整关系描述；仍无匹配如实说明，由作者设计，不伪造编号或启用其他检索流程。
