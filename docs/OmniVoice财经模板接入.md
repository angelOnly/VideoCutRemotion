# 财经模板女声接入

新版模板将财小策绑定为 `finance.female.01`，室长继续使用 `finance.male`。在部署指定的 `DOUBAO_VOICES_FILE` JSON 中增加以下项，其他既有音色项保持不变：

```json
"finance.female.01": {
  "provider": "omnivoice",
  "url": "http://10.22.1.8:8017/v1/voice-clone",
  "tag": "女声01"
}
```

声音服务逐句调用接口，接收 WAV，测量真实解码采样数并交由时间线装配；豆包音色仍接收 MP3。声音复用依据包含音色配置，语速仅支持默认值 0。服务不可达或音频无效时记录错误，不自动更换音色。无法确认供应商是否处理的请求沿原任务标记为结果未知。

模板打包使用 `scripts/prepare-finance-template.py --source <完整源模板目录> --output <新目录>`，脚本生成同名 ZIP。新版模板将时间线背景音乐初始音量设为 0.5；应与旧成片对照试听并由编辑确认。模板与运行包必须配套，只有代码和模板均验证完成才能发布。

本次模板基于模板库中 2.0.11 版本，重新打包为 2.0.13。可使用以下命令重建：

```bash
python3 scripts/build-finance-omnivoice.py --source <财经模板2.0.11的ZIP路径> --output <新模板ZIP路径>
```

启用前须先安装已验证的新运行包并配置女声音色映射。
