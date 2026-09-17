# 开发与验证

## 环境

- Node.js 24 LTS，pnpm 11.19.0（版本锁定于 `package.json`）。
- VS Code 1.100+；浏览器检查需要 Google Chrome。
- `pnpm install --frozen-lockfile` 安装构建、打包和 Playwright 依赖。开发依赖不打入 VSIX。
- 使用其他位置的 Playwright 时可设置 `PLAYWRIGHT_MODULE`，正常安装无需此变量。

## 目录与职责

```text
src/
  extension.js          扩展入口、会话及消息协调
  browser.js            Chrome 管道、按键、官网状态和结果回执
  site.js               官网设置与结果读取
  completions.js        当前文件及语言服务补全建议
  code-progress.js      代码显示步长与旧进度恢复
  result-report.js      本地 JSON / HTML 报告
  speech/
    sentence.js         英文词清理、句段切分和上下文
    tts.js              系统语音、HTTP 协议与预生成缓存
  views/
    practice.js         练习页 HTML、资源和内容安全策略
    reference-panel.js  参考音频配置及面板
media/                  Webview 脚本、样式和共享错字反馈
test/                   单元、宿主模拟、浏览器与模型验证
scripts/                发布包构建
config/                 可分发示例配置
docs/                   使用、接入、开发说明
.github/workflows/      持续集成
```

`dist/`、`releases/`、`.test-output/` 为生成目录；`runtime/`、`models/`、`.local/`、`config/*-local*` 为本机环境与资料，均被 Git 忽略。不要把模型或个人浏览器配置加入 VSIX。

浏览器模块不依赖 VS Code，语音协议与缓存不依赖 DOM。`extension.js` 协调输入、语音与持久化，Webview 负责显示和实际播放。`media/word-feedback.js` 在宿主与页面共享，避免两处反馈规则漂移。

## 自测

本次正式版的执行结果见 [1.0.0 发布验证](validation.md)。

| 命令 | 范围 | 前提 |
| --- | --- | --- |
| `pnpm test` | 输入校验、宿主消息、进度、分句、TTS 协议、缓存、参考及报告 | 无需外部模型 |
| `pnpm test:browser` | Chrome 管道、按键焦点保护、结果读取 | Chrome，本地测试页面 |
| `pnpm test:ui` | 布局、控件、键盘、FIFO 朗读及取消 | Chrome，不登录官网 |
| `node test/references-ui-smoke.js config/gpt-sovits-local-settings.json` | 参考字幕、切换、录音解码及窄屏布局 | 本机参考库 |
| `node test/gpt-sovits-live-smoke.js config/gpt-sovits-local-settings.json` | 真实短词/句子合成及缓存 | 已启动 GPT-SoVITS |
| `node test/live-smoke.js` | 当前官网 DOM 读取 | 可联网，独立访客浏览器 |
| `node test/background-smoke.js` | Windows 窗口遮挡、最小化与恢复 | Windows 桌面 |

输出位于 `.test-output/`，测试完成且相关浏览器关闭后可删除。模型检查产生语音 WAV，不自动提交官网成绩。旧 XTTS / Kokoro 诊断脚本仍保留，运行前需要对应服务，不能作为 GPT-SoVITS 必需检查。

在 VS Code 按 F5 会先构建，再打开扩展开发宿主。可通过 `--extensionTestsPath=test/host-smoke.cjs` 在隔离宿主中验证扩展激活与浏览器连接。不要对日常浏览器配置运行测试脚本。

## 构建与发布

1. 修改 `package.json` 版本和 `CHANGELOG.md`，更新 README 中的安装文件名。
2. 运行单元、浏览器、界面检查；涉及模型协议时运行真实模型验证。
3. `pnpm package` 自动构建并生成 `releases/typeecho-<version>.vsix`。
4. 检查包中只有构建入口、页面资源、配置模板、文档和许可证；安装该包并重载验证。
5. 提交源码，打 `v<version>` 标签，将 VSIX 与 SHA-256 校验文件作为 GitHub Release 附件发布。

GitHub Actions 在 Windows 和 Linux 上运行单元测试、构建及打包；Windows 还执行本地浏览器和界面检查。模型权重和个人配置不进入 CI。

稳定扩展 ID 为 `local-prototype.code-type-bridge`。改变 `publisher` 或 `name` 会创建新扩展身份，导致原有扩展状态与登录目录不能直接沿用。品牌使用 `displayName`，设置和命令保持 `codeType.*`。

## 验证边界

自动检查不等同于账号实际成绩入账、不同机器的音质或长期稳定性验证。报告只在收到官网保存回执时标记成功，外部官网改版需重新检查 DOM 适配。
