# VideoFlowCut统一实施包v2

先读《统一实施稿》。本包将原F01—F15角色方法、120库衔接和模型阅读式语义检索整合，不需要先应用旧F稿/A稿。

- replacements/：22份候选修改正文，多数不是完整Skill。
- manual_edits.json：17个现有文件的精确修改范围与文本hash。
- new_files/：可选只读卡片加载脚本与12项fixture测试，按相对路径合入。
- card-loader-tests.txt：本轮临时fixture运行结果，不是实际120媒体或模型语义评估。
- integration-checks.json：文件交付与旧方法保留检查。

基线main / 939ddd17882dfe3b08128bf4cd3d1dc3b14ec849。没有应用补丁、安装插件或重跑视频，没有在完整用户工作树验证全部锚点。锚点不唯一或基线变化先合并，不覆盖。

语义判断由模型执行；Node脚本只是读取现有索引，不调用模型、不查关键词、不建立新索引。静态网页搜索仍是原关键词功能。
