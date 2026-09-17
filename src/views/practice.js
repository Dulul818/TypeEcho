const path = require('node:path');
const crypto = require('node:crypto');

const escapeHtml = text => text.replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

function htmlFor(webview, root, session, document, vscode) {
  const media = name => webview.asWebviewUri(vscode.Uri.joinPath(root, 'media', name));
  const nonce = crypto.randomBytes(18).toString('base64');
  const config = vscode.workspace.getConfiguration('editor', document.uri);
  const fontSize = Math.min(40, Math.max(10, Number(config.get('fontSize')) || 14));
  const configuredFont = String(config.get('fontFamily') || 'Consolas, monospace');
  const fontFamily = /^[\p{L}\p{N}\s,'"._-]+$/u.test(configuredFont) ? configuredFont : 'Consolas, monospace';
  const tabSize = Math.min(8, Math.max(1, Number(config.get('tabSize')) || 4));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src data:; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="${media('practice.css')}">
    <style nonce="${nonce}">body{--code-font:${fontFamily};--code-size:${fontSize}px;--code-tab:${tabSize}}</style>
    </head><body class="reading-strip" data-session="${session}" data-display="dock" data-dock-style="compact" data-dock-position="full">
    <div id="breadcrumb"><span id="file-name">${escapeHtml(path.basename(document.fileName))}</span><span id="file-language"> › ${escapeHtml(document.languageId)}</span><details id="tools-menu"><summary aria-label="练习操作" title="练习操作">⋯</summary><div class="toolbar"><button id="next-test" disabled>Next test</button><button id="repeat-test" disabled>Repeat test</button><button id="settings-toggle">测试设置</button><button id="speech-toggle">语音设置</button><button id="relay-files">选择接力文件…</button><button id="relay-clear">清空接力队列</button><button id="open">打开官网</button><button id="result">查看成绩</button></div></details></div>
    <section id="settings-panel" hidden><div class="display-settings"><label>显示方式<select id="display-mode"><option value="dock">底部阅读条</option><option value="statusbar">原生状态栏</option><option value="comment">顶部代码注释</option><option value="reading">顶部阅读区</option><option value="inline">光标后注释</option></select></label><label id="statusbar-words-label">预览词数<select id="statusbar-words"><option value="4">4</option><option value="8" selected>8</option><option value="12">12</option><option value="16">16</option></select></label>
    <div id="dock-options"><label>位置<select id="dock-position"><option value="full">底部左下</option><option value="center">底部居中</option><option value="right">底部靠右</option></select></label><label>外观<select id="dock-style"><option value="compact">紧凑阅读条</option><option value="standard">标准阅读条</option></select></label><label id="dock-width-label">宽度<input id="dock-width" type="number" min="240" max="960" step="10" value="480">px</label><label><input id="show-dock-caret" type="checkbox" checked>显示光标</label></div>
    <div id="reading-options"><label>字号<input id="dock-font" type="number" min="12" max="24" step="1" value="13"></label><label><input id="dock-lines" type="checkbox">双行显示</label><label><input id="hover-only" type="checkbox">悬停显示</label><label><input id="hide-on-blur" type="checkbox">失焦隐藏</label></div>
    <label id="show-progress-label"><input id="show-progress" type="checkbox">显示字数进度</label>
    <label id="screen-centered-label" hidden title="鼠标经过阅读区后校准显示器中点；超出编辑区时自动限制在边缘。"><input id="screen-centered" type="checkbox">显示器居中</label>
    <label id="inline-words-label" hidden>预览词数<select id="inline-words"><option value="2" selected>2</option><option value="4">4</option><option value="8">8</option><option value="12">12</option><option value="16">16</option></select></label>
    </div><form id="settings-form"><strong>新测试设置</strong>
      <label>模式<select id="mode"><option value="time">time</option><option value="words">words</option><option value="quote">quote</option></select></label>
      <label>长度<select id="amount"></select></label>
      <label>词库<select id="language"><option value="english">English</option><option value="english_1k">English 1k</option><option value="english_5k">English 5k</option><option value="english_10k">English 10k</option><option value="english_25k">English 25k</option></select></label>
      <label><input type="checkbox" id="punctuation">标点</label><label><input type="checkbox" id="numbers">数字</label>
      <button type="submit">应用并开始新测试</button><small>使用官网的共享测试设置；应用会结束当前练习。更多选项可在官网调整。</small></form></section>
    <section id="speech-panel" hidden><label><input id="speech-enabled" type="checkbox" checked>开启朗读</label><label>朗读方式<select id="speech-mode"><option value="word">逐词</option><option value="sentence">按句</option><option value="hybrid">混合</option></select></label><label title="仅混合模式：整句读完后，只补读当前输错或停顿的词"><input id="smart-speech" type="checkbox">智能补词</label><label>音量<input id="speech-volume" type="range" min="0" max="300" step="5" value="100"><output id="speech-volume-value">100%</output></label><button id="speech-replay" hidden>重听当前句</button><button id="speech-references">参考音频与试听…</button><button id="speech-configure">接口、音色和语速…</button><span id="speech-status" role="status"></span></section>
    <section id="prompt-panel" aria-label="固定打字阅读区"><div class="comment-open">/*</div><span id="word-position" hidden></span><div id="dock-progress" aria-label="当前词输入进度">0 / 0</div><div id="word-window"><div id="word-list"></div><span id="reading-caret" aria-hidden="true" hidden></span></div><div id="input-line"><span>*/</span><span id="input-echo"></span><span id="input-status" hidden>Space 换词 · Backspace 改错</span></div></section>
    <main id="editor" tabindex="0" role="region" aria-label="代码外观打字练习，Escape 退出">
      <div id="gutter" aria-hidden="true">1</div>
      <div id="content"><pre><code id="code"></code><span id="caret" aria-hidden="true"></span><span id="inline-hint" aria-label="光标后单词提示"></span></pre><div id="suggestions" hidden aria-label="代码补全建议（仅显示）"></div></div>
    </main>
    <section id="report" hidden><div class="report-toolbar"><strong>OUTPUT · Typing test</strong><button id="report-next" disabled>Next test</button><button id="report-repeat" disabled>Repeat test</button><button id="export">打开 JSON</button><button id="print">打印报告</button><button id="report-close" aria-label="收起成绩">×</button></div><pre id="metrics"></pre><p id="account-status"></p><p id="local-status"></p></section>
    <footer><button id="resume" title="点击开始接收按键，Esc 返回原文件">就绪</button><span id="tts-status" role="status">等待语音准备</span><button id="tts-retry" title="重试语音准备" aria-label="重试语音准备" hidden>↻</button><span id="note">Ln 1, Col 1</span></footer>
    <script nonce="${nonce}" src="${media('word-feedback.js')}"></script><script nonce="${nonce}" src="${media('practice.js')}"></script></body></html>`;
}

module.exports = { htmlFor, escapeHtml };
