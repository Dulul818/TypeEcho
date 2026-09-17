# GPT-SoVITS v2ProPlus

TypeEcho 直接调用官方 `api_v2.py` 的 `/tts`，不需要额外转接服务。扩展不训练模型、不自动切换服务端权重，参考音频可在插件中随时切换。

## 准备模型服务

使用与训练产物匹配的 [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) 版本及官方安装说明，准备：

- GPT `.ckpt` 和 SoVITS `.pth` 推理权重。
- 官方要求的文本、HuBERT、说话人特征等预训练资源；仅两个微调权重不足以启动。
- 一段干净、完整的 3–10 秒参考录音及逐字对应的字幕。
- 官方 Python / PyTorch 环境；GPU 推理可使用匹配的 CUDA 和半精度。

RTX 4090 24GB 可用于 v2ProPlus 微调，实际批量取决于片段长度与训练参数。本机曾在 RTX 5060 8GB 上验证单用户推理；硬件名称不能保证所有配置都能装入显存。

复制 `config/gpt-sovits-infer.example.yaml` 为本机配置，替换模型与资源路径。在 GPT-SoVITS 源码目录使用其 Python 环境运行：

```powershell
python api_v2.py -c "D:/TypeEcho/config/gpt-sovits-local.yaml" -a 127.0.0.1 -p 9880
```

路径仅为示例。保持模型服务运行，再配置扩展。官方依赖、训练数据和模型遵循各自许可证，不随 TypeEcho 分发。

## 设置扩展

运行 **TypeEcho: 语音设置**，或参考 `config/gpt-sovits-settings.example.json`。

| 设置 | 用途 |
| --- | --- |
| `codeType.ttsProvider` | 选择 `gpt-sovits` |
| `codeType.ttsEndpoint` | 如 `http://127.0.0.1:9880/tts` |
| `codeType.ttsReference` | 原子保存 `{audio, text, language}`，优先于旧独立字段 |
| `codeType.ttsReferenceAudio` | 未使用上述对象时的参考音频绝对路径 |
| `codeType.ttsReferenceText` | 对应录音的真实字幕 |
| `codeType.ttsReferenceLanguage` | 参考语言，英文为 `en` |
| `codeType.ttsReferenceLibrary` | 可选参考列表 JSON 的绝对路径 |
| `codeType.ttsRate` | 语速 0.5–2，建议先以 1 验证 |

参考路径属于 **API 所在机器**。扩展发送路径和字幕，不上传录音；原录音试听需要扩展运行机器也能访问该文件。`ttsVoice` 在此模式下不使用，`ttsEndpoint` 留空时使用系统语音。

## 参考音频面板

通过 **TypeEcho: 参考音频与试听** 或练习页的语音设置打开。

- 每条参考显示实际字幕及原录音播放控件。
- 选择后音频、字幕和语言一起保存，练习中的旧音色缓存与队列清空。
- 导入时可读取同名 `.txt` 作为字幕初值，确认文字和语言后保留在列表中。
- 模型试听使用当前选择生成英文文本；生成期间改换参考后，旧结果会被丢弃。
- 文件保留原位置，移动或删除后需重新导入。

参考列表格式：

```json
[
  {
    "audio": "reference-a.wav",
    "text": "The exact transcript of this recording.",
    "language": "en"
  }
]
```

音频相对路径以 JSON 所在目录为基准，显示名称来自音频文件名，列表最多 100 项。参考语言支持 `en / zh / ja / ko / yue`，服务端必须具备对应语言依赖；练习目标仍为英文。

## 请求与排队

使用固定种子 `1234`、`top_k:15`、`top_p:1`、`temperature:1`、`repetition_penalty:1.35`，发送准确练习原文及参考字幕。沿用插件分句，`text_split_method:cut0`、`batch_size:1`，返回完整 WAV，`streaming_mode:false`。

`parallel_infer:true` 是单个请求内部的推理优化。练习队列同一时间只执行一个 GPT-SoVITS 请求，当前播放优先于未开始的后台工作，但不能抢占已开始的 GPU 推理。已有缓存直接返回。

`fragment_interval` 对单词为 **0.03 秒**，多词文本为 **0.3 秒**。这控制额外补入的静音，不裁剪实际发音。真实对照中，7 个常见词的有效 PCM 波形一致，各减少 270ms 尾部空等。

整局已知句段异步准备，附近单词最多向前准备 32 词。状态条区分等待模型、加载音频、朗读中和播放排队。未命中缓存仍需推理，完整逐词朗读也可能慢于输入。

更改参考路径、字幕、语言、接口或语速后使用新缓存。在同一路径覆盖音频或模型文件时，请重启 API 并重载 VS Code。单次请求限时 30 秒，音频最多 12MiB，接口错误显示在语音状态中。

## 验证与排查

```sh
node test/gpt-sovits-live-smoke.js config/gpt-sovits-local-settings.json
node test/references-ui-smoke.js config/gpt-sovits-local-settings.json
```

先按配置示例填写本机路径。第一项生成常见单词和句子，检查 WAV 及缓存并记录耗时；第二项验证参考面板。输出位于 `.test-output/`，可试听后清理。

- 首次请求含模型预热，耗时通常高于后续请求。
- “等待模型”表示准备未完成；“朗读中 · 排队 N”表示前面的发音尚未播完。
- 参考录音应无背景音乐、重叠说话或错误字幕，换参考后需检查短词和完整句子。
- 孤立短词缺少上下文，固定种子不能保证所有词都自然。
- 与练习同时执行额外模型试听可能竞争同一个服务，比较性能时先暂停练习。

本机权重、参考库、运行依赖和历史记录保留在忽略目录中，不属于可移植安装环境。迁移机器时重新创建官方环境并配置实际路径。
