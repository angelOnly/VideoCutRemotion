当用户有**两台或更多摄像机记录同一时刻**时——线索包括 “both angles”“the same interview”“multi angles”“alternate angle”“cut to the other angle”“angle switch”、换角度、两个机位——切换到另一个角度表示画面变化，但**音频和口型同步必须仍然与同一次拍摄匹配**。

**不要使用 `edit_item` 手动计算源偏移来对齐角度。** 只要底层参考角度被裁切，手动偏移就会发生漂移，而且通常要到后面才会表现为口型不同步。应使用 **`multicam_sync`** 工具：它运行编辑器基于音频的对齐引擎，并重新定位每个角度片段，使其画面与参考角度音频匹配。传入角度片段的 `itemIds`（参考角度和跟随角度）；也可以指定 `referenceItemId`。

关键约束：一个跨越参考角度剪切点的**单个 Cutaway 片段**不能作为整体完成对齐——先在该剪切点使用 `split_item` 拆开，然后把两段都传给 `multicam_sync`，使每段分别映射到下方参考 Segment。

`multicam_sync` 在用户编辑器中运行（没有后端路径）：如果它报告编辑器没有打开，让用户打开 Project，然后重试。应用后，重新读取 Project，确认对齐结果。

