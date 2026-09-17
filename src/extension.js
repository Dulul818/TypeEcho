const vscode = require('vscode');
const path = require('node:path');
const crypto = require('node:crypto');
const hljs = require('highlight.js/lib/core');
const { BrowserBridge, findBrowser, launchLogin } = require('./browser');
const { suggestions } = require('./completions');
const { writeReport } = require('./result-report');
const { requestSpeech, createSystemSpeaker, createSpeechCache } = require('./speech/tts');
const { codeProgress } = require('./code-progress');
const { updateWordFeedback } = require('../media/word-feedback');
const { SentenceContext, MAX_TEXT, speechWord, sentenceWordCount } = require('./speech/sentence');
const { registerReferencePanel } = require('./views/reference-panel');

function progressKey(document, source) {
  const hash = crypto.createHash('sha256').update(source).digest('hex').slice(0, 20);
  return `progress:${document.uri.toString()}:${hash}`;
}
function documentTabSize(document, editor) {
  const visible = editor?.document === document ? editor : vscode.window.visibleTextEditors?.find(item => item.document === document);
  const detected = visible?.options?.tabSize;
  const configured = vscode.workspace.getConfiguration('editor', document.uri).get('tabSize');
  return Math.min(32, Math.max(1, Number(detected) || Number(configured) || 4));
}
for (const [name, grammar] of Object.entries({
  javascript: require('highlight.js/lib/languages/javascript'),
  typescript: require('highlight.js/lib/languages/typescript'),
  python: require('highlight.js/lib/languages/python'),
  json: require('highlight.js/lib/languages/json'),
  css: require('highlight.js/lib/languages/css'),
  xml: require('highlight.js/lib/languages/xml'),
  java: require('highlight.js/lib/languages/java'),
  cpp: require('highlight.js/lib/languages/cpp'),
  csharp: require('highlight.js/lib/languages/csharp'),
  go: require('highlight.js/lib/languages/go'),
  rust: require('highlight.js/lib/languages/rust'),
})) hljs.registerLanguage(name, grammar);

const { htmlFor: practiceHtml, escapeHtml } = require('./views/practice');
const htmlFor = (webview, root, session, document) => practiceHtml(webview, root, session, document, vscode);
let bridge;
let panel;
let progressWrites = Promise.resolve();
let sessionFinish = Promise.resolve();
let resetProgress;

function activate(context) {
  const openReferences=registerReferencePanel(vscode,context);
  let receipt;
  let starting = false;
  let connecting;
  let loginBrowser;
  let openingLogin = false;
  let onReceipt;
  let showResult;
  let refreshRelay;
  const profile = path.join(context.globalStorageUri.fsPath, 'browser-profile');
  const executable = () => findBrowser(vscode.workspace.getConfiguration('codeType').get('browserPath'));
  const loginIsOpen = () => loginBrowser && loginBrowser.exitCode === null && loginBrowser.signalCode === null;
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 5);
  status.command = 'codeType.result';
  status.text = '$(plug)';
  status.tooltip = 'TypeEcho：查看官网保存状态';
  context.subscriptions.push(status);

  function report(error) { return vscode.window.showErrorMessage(`TypeEcho：${error.message || error}`); }

  async function connect() {
    if (openingLogin || loginIsOpen()) throw new Error('请先在普通 Chrome 窗口完成登录，然后关闭该窗口，再开始练习。');
    if (bridge && !bridge.closed) return bridge;
    if (connecting) return connecting;
    connecting = (async () => {
      const next = new BrowserBridge();
      next.on('receipt', value => {
        onReceipt?.(value);
        if (value.round !== undefined && value.round !== next.round) return;
        receipt = value;
        status.text = value.saved ? '$(check)' : '$(warning)';
        status.tooltip = value.text;
      });
      next.on('disconnected', reason => {
        panel?.webview.postMessage({ type: 'halt', text: reason });
        status.text = '$(debug-disconnect)';
        status.tooltip = reason;
      });
      next.on('notice', text => {
        status.tooltip = text;
      });
      try {
        await next.launch(executable(), profile);
      } catch (error) {
        await next.close();
        throw new Error(`${error.message} 请确认用于登录的普通 Chrome 窗口已关闭。`);
      }
      bridge = next;
      status.show();
      return next;
    })();
    try { return await connecting; } finally { connecting = undefined; }
  }

  async function start() {
    if (starting) return;
    if (panel) { panel.reveal(); return; }
    const editor = vscode.window.activeTextEditor;
    if (!editor || !editor.document.getText()) throw new Error('请先打开一个有内容的代码文件。');
    let source = editor.document.getText().replace(/\r\n/g, '\n');
    if (source.length > 100000) throw new Error('支持最多 100,000 个字符，请选择较小的代码文件。');
    starting = true;
    try {
      const browser = await connect();
      const state = await browser.attach();
      if (!state.ready && !state.finished && !state.target) throw new Error(state.reason);
      receipt = undefined;
      status.text = '$(plug)';
      status.tooltip = '尚未确认官网保存成绩。';
      const current = vscode.window.createWebviewPanel('codeType.practice',
        path.basename(editor.document.fileName), editor.viewColumn || vscode.ViewColumn.One, {
          enableScripts: true, retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
        });
      panel = current;
      const session = crypto.randomUUID();
      await sessionFinish;
      await progressWrites;
      function snapshot(document) {
        const source = document.getText().replace(/\r\n/g, '\n');
        if (!source || source.length > 100000) throw new Error(`${path.basename(document.fileName)} 为空或超过 100,000 字符。`);
        const key = progressKey(document, source);
        return { document, source, key, ...codeProgress(source, context.globalState.get(key)) };
      }
      async function relayFiles(first) {
        const selected = context.globalState.get('relayFiles') || [];
        const files = [first];
        const skipped = [];
        for (const address of [...new Set(selected)].filter(address => address !== first.document.uri.toString())) {
          try { files.push(snapshot(await vscode.workspace.openTextDocument(vscode.Uri.parse(address)))); }
          catch { skipped.push(address); }
        }
        if (skipped.length) void vscode.window.showWarningMessage(`已跳过 ${skipped.length} 个无法读取、为空或过大的接力文件。可重新选择接力文件。`);
        return files;
      }
      let files = await relayFiles(snapshot(editor.document));
      let fileIndex = 0;
      let document, cuts, savedProgressKey, progress, language;
      function selectFile(index) {
        fileIndex = index;
        ({ document, source, cuts, key: savedProgressKey, progress } = files[index]);
        language = ({ javascriptreact: 'javascript', typescriptreact: 'typescript', html: 'xml', c: 'cpp' })[document.languageId] || document.languageId;
        current.title = path.basename(document.fileName);
      }
      selectFile(Math.max(0, files.findIndex(file => file.progress < file.cuts.length - 1)));
      const saveProgress = () => {
        files[fileIndex].progress = progress;
        const key = savedProgressKey;
        const value = progress > 0
          ? { progress, offset: cuts[progress], updatedAt: new Date().toISOString(), file: path.basename(document.fileName) } : undefined;
        progressWrites = progressWrites.then(() => context.globalState.update(key, value)).catch(error => {
          status.text = '$(warning)';
          status.tooltip = `代码进度保存失败：${error.message}`;
        });
        return progressWrites;
      };
      let active = false;
      let disposed = false;
      let pending = 0;
      let queue = Promise.resolve();
      let releasing = Promise.resolve();
      let generation = 0;
      let pollBusy = false;
      let inputRevision = 0;
      let renderTimer;
      let revealPending = false;
      let actionBusy = false;
      let resultWork;
      let capturedRound = -1;
      let lastRecord;
      let writes = Promise.resolve();
      let completionTimer;
      const savedPreferences = context.globalState.get('practicePreferences');
      let preferences = { displayMode: 'dock', speechEnabled: true, statusbarWords: 8, inlineWords: 2, dockFont:13, dockLines:1, dockStyle:'compact', dockPosition:'full', dockWidth:480, hoverOnly:false, hideOnBlur:false, ...savedPreferences };
      if (savedPreferences?.displayMode === 'statusbar' && savedPreferences.dockFont === undefined) {
        preferences.displayMode = 'dock';
        await context.globalState.update('practicePreferences',preferences);
      }
      if (preferences.displayMode === 'dock' && savedPreferences?.dockStyle === undefined) {
        preferences.dockFont = 13;
        preferences.dockLines = 1;
        await context.globalState.update('practicePreferences',preferences);
      }
      if (preferences.displayMode === 'corner') {
        preferences.displayMode = 'dock';
        preferences.dockPosition = 'right';
        preferences.dockWidth = savedPreferences.cornerWidth || 480;
        preferences.hideOnBlur = true;
        preferences.dockStyle = 'standard';
      }
      if (preferences.dockStyle === 'hover') {
        preferences.dockStyle = 'compact';
        preferences.hoverOnly = true;
      }
      delete preferences.cornerWidth;
      preferences.showProgress ??= preferences.dockStyle === 'standard' || preferences.displayMode === 'statusbar';
      preferences.screenCentered ??= false;
      preferences.showDockCaret ??= true;
      preferences.speechMode = ['sentence','hybrid'].includes(preferences.speechMode) ? preferences.speechMode : 'word';
      preferences.smartSpeech = preferences.smartSpeech === true;
      await context.globalState.update('practicePreferences',preferences);
      let speechRequest;
      let preparation={ready:0,total:0,failed:0};
      let speechTextRequest, loadedSpeechRevision, speechTextRetryAt=0, speechTextError='';
      let preparationTimer;
      const sendPreparation=()=>{
        if (!disposed) void current.webview.postMessage({type:'speech-preparation',epoch:speechEpoch,...preparation,
          reading:Boolean(speechTextRequest),paused:!prefetchAllowed,contextError:speechTextError});
      };
      const speechCache = createSpeechCache(requestSpeech, progress=>{ preparation=progress; sendPreparation(); });
      let speechCacheSettings;
      let speechPreparationKey;
      let prefetchAllowed = true;
      let speechEpoch=0;
      let speechReach=-1;
      const sentenceContext=new SentenceContext();
      let systemSpeaker;
      let currentSpeechId;
      let currentSpeechUnit;
      let lastState = state;
      function speechSettings() {
        const config = vscode.workspace.getConfiguration('codeType');
        const endpoint = String(config.get('ttsEndpoint') || '').trim();
        const options = {voice:String(config.get('ttsVoice') || '').trim(),rate:Math.max(0.5,Math.min(2,Number(config.get('ttsRate')) || 1))};
        const reference=config.get('ttsReference');
        if (config.get('ttsProvider')==='gpt-sovits') Object.assign(options,{
          provider:'gpt-sovits',referenceAudio:String(reference?.audio || config.get('ttsReferenceAudio') || '').trim(),
          referenceText:String(reference?.text || config.get('ttsReferenceText') || '').trim(),referenceLanguage:reference?.language || config.get('ttsReferenceLanguage') || 'en',
        });
        const signature = JSON.stringify([endpoint, options]);
        if (signature !== speechCacheSettings) { speechCache.clear(); speechCacheSettings = signature; }
        return {endpoint, options};
      }
      function prepareSpeech() {
        preparationTimer ??= setImmediate(()=>{ preparationTimer=undefined; runPreparation(); });
      }
      function runPreparation() {
        if (disposed) return;
        if (!prefetchAllowed || !preferences.speechEnabled || !current.active || !lastState.ready || lastState.finished) { speechPreparationKey=undefined; return; }
        const {endpoint, options} = speechSettings();
        if (!endpoint) { preparation={ready:0,total:0,failed:0,system:true}; sendPreparation(); return; }
        const wordMode = lastState.testMode === 'words' || preferences.speechMode === 'word';
        if (!wordMode && browser.speechSnapshot && lastState.speechRevision && loadedSpeechRevision!==lastState.speechRevision && !speechTextRequest && Date.now()>=speechTextRetryAt) {
          const epoch=speechEpoch, generationAtRead=generation;
          speechTextError='';
          speechTextRequest=browser.speechSnapshot().then(full=>{
            if (disposed || epoch!==speechEpoch || generation!==generationAtRead || !prefetchAllowed || !preferences.speechEnabled || !lastState.ready || lastState.finished) return;
            if (full?.speechRevision!==lastState.speechRevision || full.testId!==lastState.testId) return;
            loadedSpeechRevision=full.speechRevision;
            // Merge only original text; never replace current typing with an older snapshot.
            post({type:'state',...lastState,speechWords:full.speechWords,speechEnd:full.speechEnd});
          }).catch(error=>{
            if (epoch!==speechEpoch || generation!==generationAtRead || disposed) return;
            speechTextError=error.message; speechTextRetryAt=Date.now()+5000;
          }).finally(()=>{ speechTextRequest=undefined; sendPreparation(); prepareSpeech(); });
          sendPreparation();
        }
        const key=JSON.stringify([speechCacheSettings,speechEpoch,lastState.wordIndex,lastState.testMode,preferences.speechMode,currentSpeechUnit,sentenceContext.words.size,sentenceContext.segments.length]);
        if (key===speechPreparationKey) return;
        speechPreparationKey=key;
        const words = [lastState.target, ...Array.from({length:32},(_,offset)=>sentenceContext.words.get(lastState.wordIndex+offset+1))].map(speechWord);
        const closeWords=words.slice(0,6), extraWords=words.slice(6);
        const sentences = wordMode ? [] : sentenceContext.segments.filter(segment => sentenceWordCount(segment.text)>=2).map(segment => segment.text);
        const nearby=sentenceContext.segments.filter(segment=>segment.end>lastState.wordIndex).slice(0,3).map(segment=>sentenceWordCount(segment.text)>=2 ? segment.text : undefined);
        const texts = wordMode ? words : preferences.speechMode === 'sentence' ? [...nearby,...sentences]
          : currentSpeechUnit === 'word' ? [...closeWords, ...nearby, ...extraWords, ...sentences]
          : [nearby[0], closeWords[0], nearby[1], ...closeWords.slice(1), nearby[2], ...extraWords, ...sentences];
        speechCache.prepare(endpoint, [...new Set(texts)].filter(text => typeof text === 'string' && /^[\x20-\x7e]{1,1200}$/.test(text)), options, sentences);
      }
      const statusWords = new Map();
      const wordHistory = new Map();
      let statusGroupStart;
      let statusGroupCount;
      const wordStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
      wordStatus.command = 'codeType.start';
      function updateWordStatus() {
        if (disposed || !current.active || preferences.displayMode !== 'statusbar' || !lastState.target || lastState.finished) { wordStatus.hide(); return; }
        const target = lastState.target;
        const typed = lastState.typed || '';
        const count = [4,8,12,16].includes(preferences.statusbarWords) ? preferences.statusbarWords : 8;
        const index = lastState.wordIndex ?? 0;
        if (statusWords.has(index) && statusWords.get(index) !== target) { statusWords.clear(); statusGroupStart = undefined; }
        for (const word of lastState.preview || []) statusWords.set(word.index,word.text);
        statusWords.set(index,target);
        if (lastState.next) statusWords.set(index+1,lastState.next);
        for (const key of statusWords.keys()) if (key < index-48 || key > index+72) statusWords.delete(key);
        if (statusGroupStart === undefined || statusGroupCount !== count) statusGroupStart = index;
        else if (index < statusGroupStart || index >= statusGroupStart+count) statusGroupStart += Math.floor((index-statusGroupStart)/count)*count;
        statusGroupCount = count;
        const group = Array.from({length:count},(_,i)=>statusGroupStart+i).filter(key=>statusWords.has(key));
        const words = group.map(key=>key===index ? `[${statusWords.get(key)}]` : statusWords.get(key));
        const wrongWords=group.filter(key=>wordHistory.get(key)?.errors.length || wordHistory.get(key)?.extra).map(key=>statusWords.get(key));
        wordStatus.color=wrongWords.length ? new vscode.ThemeColor('errorForeground') : undefined;
        wordStatus.text = `${preferences.showProgress ? `[${typed.length}/${target.length}${target.startsWith(typed) ? '' : '!'}] ` : ''}${words.join('  ')}`.replace(/\$\(/g, '$ (');
        wordStatus.tooltip = `目标：${target}\n本组第 ${index-statusGroupStart+1} 词\n已输入：${typed || '（空）'}${target.startsWith(typed) ? '' : '\n输入有误，Backspace 改错'}${wrongWords.length ? '\n错词：'+wrongWords.join('、') : ''}\n\n${group.map(key=>statusWords.get(key)).join(' ')}\n\n点击返回练习页`;
        wordStatus.show();
      }
      const records = new Map();
      const down = new Map();

      const post = message => {
        if (disposed) return;
        if (message.type === 'round-reset') {
          loadedSpeechRevision=undefined; speechTextRetryAt=0; speechTextError='';
          preparation={ready:0,total:0,failed:0}; currentSpeechUnit=undefined;
          statusWords.clear(); wordHistory.clear(); statusGroupStart = undefined;
          sentenceContext.reset(); speechEpoch++; speechRequest?.abort(); systemSpeaker?.stop();
          speechReach=-1;
          speechCache.clear();
        }
        if (message.type === 'state') {
          if (lastState.finished && message.target || message.testId && lastState.testId && message.testId!==lastState.testId) { preparation={ready:0,total:0,failed:0}; currentSpeechUnit=undefined; loadedSpeechRevision=undefined; speechTextRetryAt=0; speechTextError=''; sentenceContext.reset(); speechEpoch++; speechReach=-1; speechRequest?.abort(); systemSpeaker?.stop(); speechCache.clear(); }
          const context=sentenceContext.update(message);
          if(context.changed) { preparation={ready:0,total:0,failed:0}; currentSpeechUnit=undefined; speechEpoch++; speechReach=-1; speechRequest?.abort(); systemSpeaker?.stop(); speechCache.clear(); }
          if (message.target) speechReach=Math.max(speechReach,(message.wordIndex ?? 0)+(message.typed===message.target ? 1 : 0));
          message={...message,sentence:context.sentence,nextSentence:context.nextSentence,speechEpoch};
          if (!message.ready || message.finished) { speechPreparationKey=undefined; speechRequest?.abort(); systemSpeaker?.stop(); speechCache.clear(); }
          // The Webview owns FIFO playback; typing transitions do not cancel queued speech.
          if (lastState.testMode!==message.testMode) { speechRequest?.abort(); systemSpeaker?.stop(); }
          updateWordFeedback(wordHistory,message);
          lastState = message;
          updateWordStatus();
          if (lastRecord && message.finished && Number.isInteger(message.level) && lastRecord.level !== message.level) {
            lastRecord.level = message.level;
            displayReport(lastRecord);
            void persist(lastRecord);
          }
        }
        const {speechWords,...viewMessage}=message;
        void current.webview.postMessage(viewMessage);
        if (message.type === 'state') prepareSpeech();
      };
      const reportsDirectory = path.join(context.globalStorageUri.fsPath, 'results');
      function displayReport(record) {
        if (record.round !== browser.round) return;
        post({ type: 'report', metrics: record.metrics, accountStatus: record.receipt?.text || record.accountStatus,
          xp: record.receipt?.saved ? record.receipt.xp : null, level: record.level ?? null,
          localStatus: record.files ? '已自动保存到本地' : '正在保存本地报告…' });
      }
      function persist(record) {
        writes = writes.catch(() => {}).then(async () => {
          record.files = await writeReport(reportsDirectory, record);
          displayReport(record);
        }).catch(error => post({ type: 'action-error', text: `本地报告保存失败：${error.message}` }));
        return writes;
      }
      const receiptHandler = value => {
        const record = records.get(value.round ?? browser.round);
        if (record) { record.receipt = value; displayReport(record); void persist(record); }
      };
      onReceipt = receiptHandler;
      showResult = () => {
        if (lastRecord) { displayReport(lastRecord); post({ type: 'show-report' }); }
        else post({ type: 'action-error', text: '测试结束后会自动显示成绩并保存本地报告。' });
      };
      async function collectResult() {
        const round = browser.round;
        await halt('测试结束，正在读取官网成绩…');
        await new Promise(resolve => setTimeout(resolve, 500));
        if (disposed || round !== browser.round) return;
        const result = await browser.captureResult();
        if (!result) return;
        const record = { ...result, id: `test-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`, round,
          createdAt: new Date().toISOString(), receipt: browser.latestReceipt,
          accountStatus: result.loggedOut ? '官网未登录，本次仅保存本地报告。' : result.retryVisible ? '官网提交失败，本地报告仍会保存。' : '等待官网保存回执；本地报告自动保存。' };
        capturedRound = round;
        lastRecord = record;
        records.set(round, record);
        displayReport(record);
        await persist(record);
      }
      function completeHints(text) {
        clearTimeout(completionTimer);
        post({ type: 'suggestions', items: suggestions(source, text.length) });
        // Language providers can publish transient diagnostics and shift VS Code's panel tabs.
        if (!vscode.workspace.getConfiguration('codeType').get('nativeCompletions',false)) return;
        if (!/[A-Za-z_$][\w$]{1,}$/.test(text)) return;
        const at = progress;
        const file = document;
        completionTimer = setTimeout(async () => {
          try {
            const lines = text.split('\n');
            const result = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', file.uri,
              new vscode.Position(lines.length - 1, lines.at(-1).length));
            if (!disposed && document === file && progress === at && active) post({ type: 'suggestions', items: suggestions(source, text.length, result?.items || []) });
          } catch { /* File symbols remain available when this language has no completion provider. */ }
        }, 100);
      }
      function render(reveal = false) {
        clearTimeout(renderTimer); renderTimer=undefined;
        reveal ||= revealPending; revealPending=false;
        // ponytail: highlight the bounded prefix each time; cache completed lines if large-file input becomes slow.
        const text = source.slice(0, cuts[progress]);
        const html = hljs.getLanguage(language) ? hljs.highlight(text, { language, ignoreIllegals: true }).value : escapeHtml(text);
        post({ type: 'code', html, lines: text.split('\n').length, complete: progress === cuts.length - 1, reveal,
          fileName: path.basename(document.fileName), language: document.languageId, relayCount: files.length,
          tabSize: documentTabSize(document, editor) });
        completeHints(text);
      }
      function scheduleRender(reveal) {
        revealPending ||= reveal;
        renderTimer ??= setTimeout(()=>render(),16);
      }
      async function halt(text) {
        active = false;
        prefetchAllowed = false;
        speechPreparationKey=undefined;
        speechCache.cancelPending();
        speechRequest?.abort();
        systemSpeaker?.stop();
        generation++;
        post({ type: 'halt', text });
        post({ type: 'suggestions', items: [] });
        const drain = queue;
        releasing = releasing.then(async () => {
          await drain.catch(() => {});
          const pressed = [...down.values()];
          down.clear();
          await browser.release(pressed);
        });
        await releasing;
      }
      const resetCurrentProgress = async () => {
        await halt('已从头显示，点击继续练习。');
        progress = 0;
        await saveProgress();
        render(true);
      };
      resetProgress = resetCurrentProgress;
      const refreshCurrentRelay = async () => {
        if (actionBusy) throw new Error('正在准备测试，请稍后更新接力文件。');
        actionBusy = true;
        try {
          await halt('接力文件已更新，点击继续。');
          await saveProgress();
          const updated = await relayFiles(files[fileIndex]);
          if (disposed) return;
          files = updated;
          selectFile(0);
          render();
        } finally { actionBusy = false; }
      };
      refreshRelay = refreshCurrentRelay;
      current.webview.onDidReceiveMessage(message => {
        if (disposed || message.session !== session) return;
        if (message.type === 'ready') {
          post({ type: 'preferences', ...preferences });
          post({type:'view-active',active:current.active && vscode.window.state?.focused !== false});
          render(true);
          post({ type: 'state', ...state });
        } else if (message.type === 'preferences') {
          if (!['statusbar', 'comment', 'reading', 'inline', 'dock'].includes(message.displayMode) || typeof message.speechEnabled !== 'boolean') return;
          if (!message.speechEnabled || message.speechMode && message.speechMode!==preferences.speechMode) { speechPreparationKey=undefined; speechRequest?.abort(); systemSpeaker?.stop(); speechCache.clear(); }
          preferences = { displayMode: message.displayMode, speechEnabled: message.speechEnabled,
            speechMode: ['word','sentence','hybrid'].includes(message.speechMode) ? message.speechMode : preferences.speechMode,
            smartSpeech: typeof message.smartSpeech === 'boolean' ? message.smartSpeech : preferences.smartSpeech,
            speechVolume: Number.isFinite(message.speechVolume) && message.speechVolume>=0 && message.speechVolume<=300 ? message.speechVolume : preferences.speechVolume ?? 100,
            statusbarWords: [4,8,12,16].includes(message.statusbarWords) ? message.statusbarWords : preferences.statusbarWords,
            inlineWords: [2,4,8,12,16].includes(message.inlineWords) ? message.inlineWords : preferences.inlineWords,
            dockFont: Number.isInteger(message.dockFont) && message.dockFont >= 12 && message.dockFont <= 24 ? message.dockFont : preferences.dockFont,
            dockLines: [1,2].includes(message.dockLines) ? message.dockLines : preferences.dockLines,
            dockStyle: ['compact','standard'].includes(message.dockStyle) ? message.dockStyle : preferences.dockStyle,
            dockPosition: ['full','center','right'].includes(message.dockPosition) ? message.dockPosition : preferences.dockPosition,
            dockWidth: Number.isInteger(message.dockWidth) && message.dockWidth >=240 && message.dockWidth<=960 ? message.dockWidth : preferences.dockWidth,
            hoverOnly: typeof message.hoverOnly === 'boolean' ? message.hoverOnly : preferences.hoverOnly,
            hideOnBlur: typeof message.hideOnBlur === 'boolean' ? message.hideOnBlur : preferences.hideOnBlur,
            showProgress: typeof message.showProgress === 'boolean' ? message.showProgress : preferences.showProgress,
            showDockCaret: typeof message.showDockCaret === 'boolean' ? message.showDockCaret : preferences.showDockCaret,
            screenCentered: typeof message.screenCentered === 'boolean' ? message.screenCentered : preferences.screenCentered };
          void context.globalState.update('practicePreferences', preferences).catch(error => post({type:'action-error',text:error.message}));
          updateWordStatus();
          prepareSpeech();
        } else if (message.type === 'speech-settings') {
          void vscode.commands.executeCommand('codeType.ttsSettings');
        } else if (message.type === 'reference-settings') {
          void vscode.commands.executeCommand('codeType.references');
        } else if (message.type === 'speech-retry') {
          speechCache.retryFailed(); speechPreparationKey=undefined; speechTextRetryAt=0;
          prepareSpeech();
        } else if (message.type === 'speech-cancel') {
          speechRequest?.abort();
          systemSpeaker?.stop();
        } else if (message.type === 'speech' && active && current.active && !actionBusy && lastState.ready && preferences.speechEnabled) {
          const sentenceSpeech=(preferences.speechMode==='sentence' || preferences.speechMode==='hybrid' && message.unit==='sentence') && lastState.testMode!=='words';
          // A valid hybrid request can arrive after the next typing snapshot.
          const sentence=sentenceSpeech && message.sentenceId
            ? sentenceContext.segments.find(segment=>segment.start<=speechReach && `${segment.start}:${segment.end}`===message.sentenceId)
            : lastState.sentence;
          const earlyWord=!sentenceSpeech && message.wordIndex===lastState.wordIndex+1 && lastState.typed===lastState.target;
          const queuedWord=!sentenceSpeech && Number.isInteger(message.wordIndex) && message.wordIndex>=0 && message.wordIndex<=speechReach;
          if (earlyWord && preferences.speechMode==='hybrid' && lastState.testMode!=='words' && message.wordIndex>=lastState.sentence?.end) return;
          if (!sentenceSpeech && message.wordIndex!==undefined && !queuedWord && !earlyWord) return;
          const expected=sentenceSpeech ? sentence?.text : queuedWord ? sentenceContext.words.get(message.wordIndex) || (message.wordIndex===lastState.wordIndex ? lastState.target : undefined) : earlyWord ? sentenceContext.words.get(message.wordIndex) || lastState.next : lastState.target;
          if (message.epoch!==speechEpoch || message.text!==expected || typeof message.text!=='string' || message.text.length>MAX_TEXT || !/^[\x20-\x7e]+$/.test(message.text) || !Number.isInteger(message.id)) return;
          speechRequest?.abort();
          const controller = speechRequest = new AbortController();
          currentSpeechId = message.id;
          currentSpeechUnit = sentenceSpeech ? 'sentence' : 'word';
          const {endpoint, options} = speechSettings();
          const text=sentenceSpeech ? message.text : speechWord(message.text);
          if (!text) { post({type:'speech-ended',id:message.id}); return; }
          if (!endpoint && process.platform === 'win32') {
            systemSpeaker ||= createSystemSpeaker(text => post({type:'speech-error',id:currentSpeechId,text}),id=>{
              if (id===currentSpeechId && !speechRequest?.signal.aborted) post({type:'speech-ended',id});
            },id=>{
              if (id===currentSpeechId && !speechRequest?.signal.aborted) post({type:'speech-started',id});
            });
            systemSpeaker.speak(text,{...options,id:message.id,volume:Math.min(100,preferences.speechVolume ?? 100)});
            return;
          }
          if (!endpoint) { post({type:'speech', id:message.id, native:true, text,...options}); return; }
          void speechCache.get(endpoint, text, options, controller.signal).then(audio => {
            if (!controller.signal.aborted) post({type:'speech',id:message.id,...audio});
          }).catch(error => {
            if (!controller.signal.aborted) post({type:'speech-error',id:message.id,text:error.message});
          });
        } else if (message.type === 'arm' && !actionBusy) {
          const armGeneration = generation;
          void (async () => {
            await queue;
            await releasing;
            if (disposed || !current.active) return;
            const fresh = await browser.waitForTest();
            if (disposed || !current.active || generation !== armGeneration) return;
            if (!fresh.ready) return halt(fresh.reason);
            active = true;
            prefetchAllowed = true;
            post({ type: 'armed' });
            post({ type: 'state', ...fresh });
          })().catch(error => void halt(error.message));
        } else if (['next-test', 'repeat-test', 'settings'].includes(message.type) && !actionBusy) {
          actionBusy = true;
          post({ type: 'busy', text: '正在准备测试…' });
          void (async () => {
            await halt('正在准备测试…');
            await resultWork;
            const fresh = message.type === 'settings' ? await browser.applySettings(message.settings) : await browser.nextTest(message.type === 'repeat-test');
            receipt = undefined;
            capturedRound = -1;
            if (disposed) return;
            post({ type: 'round-reset' });
            prefetchAllowed = true;
            post({ type: 'state', ...fresh });
            render();
            if (current.active) { active = true; post({ type: 'armed' }); }
          })().catch(error => post({ type: 'action-error', text: error.message })).finally(() => {
            actionBusy = false;
            post({ type: 'busy', value: false });
          });
        } else if (message.type === 'key' && active && current.active && !actionBusy) {
          const received = message.sentAt;
          if (!Number.isFinite(received) || received > Date.now() + 1000) { void halt('输入时间无效，已暂停。'); return; }
          const keyGeneration = generation;
          inputRevision++;
          if (++pending > 30) { pending--; void halt('输入连接积压，已暂停。请检查浏览器。'); return; }
          queue = queue.then(async () => {
            if (!active || disposed || generation !== keyGeneration) return;
            if (Date.now() - received > 250) throw new Error('输入延迟超过 250ms，已暂停，避免补发积压按键。');
            const fresh=await browser.sendKey(message.event);
            const event = message.event;
            if (event.type === 'keydown') down.set(event.code, event);
            else down.delete(event.code);
            if (disposed || generation!==keyGeneration) return;
            if (fresh) {
              post({type:'state',...fresh});
              if (!fresh.ready) void halt(fresh.reason);
            }
            if (event.type === 'keydown' && !event.repeat) {
              const previousProgress=progress;
              let switched = false;
              if (/^[\x20-\x7e]$/.test(event.key) && progress === cuts.length - 1) {
                const next = files.findIndex((file, index) => index > fileIndex && file.progress < file.cuts.length - 1);
                if (next !== -1) { selectFile(next); switched = true; }
              }
              if (event.key === 'Backspace') progress = Math.max(0, progress - 1);
              else if (/^[\x20-\x7e]$/.test(event.key)) progress = Math.min(cuts.length - 1, progress + 1);
              saveProgress();
              if (switched || progress!==previousProgress) scheduleRender(switched);
            }
          }).catch(error => {
            // Do not await halt inside the queue: halt itself drains the queue.
            void halt(error.message);
          }).finally(() => { pending--; });
        } else if (message.type === 'pause') {
          void halt('已暂停；点击此处继续。官网计时不会暂停。');
        } else if (message.type === 'stop') {
          current.dispose();
        } else if (message.type === 'browser') {
          void halt('请在官网操作完成后，点击此处继续。');
          void browser.show().catch(report);
        } else if (message.type === 'result') {
          void vscode.commands.executeCommand('codeType.result');
        } else if (message.type === 'relay-files') {
          void vscode.commands.executeCommand('codeType.selectRelayFiles');
        } else if (message.type === 'relay-clear') {
          void vscode.commands.executeCommand('codeType.clearRelayFiles');
        } else if (message.type === 'export' || message.type === 'print') {
          void (async () => {
            await resultWork;
            await writes;
            if (!lastRecord?.files) throw new Error('完成一场测试后即可打开报告。');
            if (message.type === 'print') await vscode.env.openExternal(vscode.Uri.file(lastRecord.files.html));
            else await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(lastRecord.files.json));
          })().catch(error => post({ type: 'action-error', text: error.message }));
        }
      }, undefined, context.subscriptions);
      current.onDidChangeViewState(() => {
        post({type:'view-active',active:current.active && vscode.window.state?.focused !== false});
        updateWordStatus();
        if (!current.active) void halt('已暂停；点击此处继续。官网计时不会暂停。');
      });
      const windowFocus = vscode.window.onDidChangeWindowState?.(state => {
        post({type:'view-active',active:state.focused && current.active});
        if (!state.focused) void halt('已暂停；点击继续。官网计时不会暂停。');
      });
      const timer = setInterval(async () => {
        if (disposed || pollBusy || browser.closed || actionBusy || pending) return;
        pollBusy = true;
        const revision=inputRevision, pollGeneration=generation;
        try {
          const fresh = await browser.snapshot();
          if (disposed || revision!==inputRevision || pollGeneration!==generation) return;
          post({ type: 'state', ...fresh });
          if (fresh.finished && capturedRound !== browser.round) {
            resultWork = collectResult();
            await resultWork;
          }
          if (!fresh.ready && active) void halt(fresh.reason);
        } catch (error) { if (active) void halt(error.message); }
        finally { pollBusy = false; }
      }, 150);
      const speechConfigListener=vscode.workspace.onDidChangeConfiguration?.(event=>{
        if (!['ttsReference','ttsReferenceAudio','ttsReferenceText','ttsReferenceLanguage','ttsEndpoint','ttsProvider','ttsRate','ttsVoice'].some(key=>event.affectsConfiguration(`codeType.${key}`))) return;
        speechEpoch++;speechRequest?.abort();systemSpeaker?.stop();speechCache.clear();
        speechPreparationKey=undefined;currentSpeechUnit=undefined;
        preparation={ready:0,total:0,failed:0};
        post({type:'state',...lastState});
      });
      current.onDidDispose(() => {
        speechConfigListener?.dispose();
        disposed = true;
        active = false;
        clearInterval(timer);
        clearTimeout(completionTimer);
        clearTimeout(renderTimer);
        clearImmediate(preparationTimer);
        windowFocus?.dispose();
        speechRequest?.abort();
        speechCache.clear();
        wordStatus.dispose();
        systemSpeaker?.dispose();
        if (onReceipt === receiptHandler) { onReceipt = undefined; showResult = undefined; }
        if (panel === current) panel = undefined;
        sessionFinish = halt('练习已结束。').then(saveProgress);
        if (resetProgress === resetCurrentProgress) resetProgress = undefined;
        if (refreshRelay === refreshCurrentRelay) refreshRelay = undefined;
        if (!editor.document.isClosed) void vscode.window.showTextDocument(editor.document, editor.viewColumn);
      });
      current.webview.html = htmlFor(current.webview, context.extensionUri, session, editor.document);
    } finally { starting = false; }
  }

  const commands = {
    'codeType.connect': async () => {
      if (openingLogin || loginIsOpen()) {
        void vscode.window.showInformationMessage('普通 Chrome 登录窗口已经打开；完成登录后关闭该窗口，再开始练习。');
        return;
      }
      openingLogin = true;
      try {
        if (connecting) await connecting;
        panel?.dispose();
        await bridge?.close();
        loginBrowser = await launchLogin(executable(), profile);
        void vscode.window.showInformationMessage('已打开普通 Chrome（无调试连接）。请登录 Monkeytype，完成后关闭这个窗口；再打开代码文件，运行“TypeEcho: 用当前文件开始练习”。');
      } finally { openingLogin = false; }
    },
    'codeType.start': start,
    'codeType.ttsSettings': () => vscode.commands.executeCommand('workbench.action.openSettings','@ext:local-prototype.code-type-bridge tts'),
    'codeType.references': openReferences,
    'codeType.selectRelayFiles': async () => {
      const selected = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: true,
        title: '选择接力代码文件（当前文件之后依次显示）', openLabel: '加入接力' });
      if (!selected) return;
      await context.globalState.update('relayFiles', selected.map(uri => uri.toString()));
      await refreshRelay?.();
      if (!panel) void vscode.window.showInformationMessage(`已记住 ${selected.length} 个接力文件，下次开始练习时使用。`);
    },
    'codeType.clearRelayFiles': async () => {
      await context.globalState.update('relayFiles', undefined);
      await refreshRelay?.();
    },
    'codeType.stop': () => panel?.dispose(),
    'codeType.resetProgress': () => resetProgress ? resetProgress() : vscode.window.showInformationMessage('请先打开代码练习页，再重置显示进度。'),
    'codeType.result': () => showResult ? showResult() : vscode.window.showInformationMessage(receipt?.text || '完成测试后会自动显示成绩；官网自行保存，本地报告也自动保存。'),
  };
  for (const [name, handler] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(name, (...args) => Promise.resolve().then(() => handler(...args)).catch(report)));
  }
  return { htmlFor, escapeHtml };
}

async function deactivate() {
  panel?.dispose();
  await sessionFinish;
  await progressWrites;
  await bridge?.close();
}

module.exports = { activate, deactivate, htmlFor, escapeHtml };
