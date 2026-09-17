const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { settingsUrl, readResult, readAccountLevel } = require('./site');

function findBrowser(configured = '') {
  const candidates = configured ? [configured] : process.platform === 'win32' ? [
    path.join(process.env.ProgramW6432 || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  ] : process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const executable = candidates.find(p => path.isAbsolute(p) && fs.existsSync(p));
  if (!executable) throw new Error('找不到 Google Chrome，请在 codeType.browserPath 设置 Chrome 的绝对路径。');
  return executable;
}

async function launchLogin(executable, profile) {
  fs.mkdirSync(profile, { recursive: true });
  // Login uses the normal browser; no debugger, credentials export or login-page automation.
  const child = spawn(executable, [
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'https://monkeytype.com/',
  ], { stdio: 'ignore', windowsHide: false });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  return child;
}

function isResultRequest(request) {
  try {
    const url = new URL(request.url);
    return request.method === 'POST' && url.origin === 'https://api.monkeytype.com' && /^\/results\/?$/.test(url.pathname);
  } catch { return false; }
}

function resultReceipt(status, body) {
  let data;
  try { data = JSON.parse(body); } catch { /* Show an unverified response below. */ }
  if (status >= 200 && status < 300 && typeof data?.data?.insertedId === 'string' && Number.isFinite(data.data.xp)) {
    return { saved: true, xp: data.data.xp, text: `官网已保存本次成绩，经验 +${data.data.xp}。` };
  }
  return { saved: false, text: `未确认官网保存成功（HTTP ${status}）。${String(data?.message || '请到官网查看结果。').slice(0,200)}` };
}

function keyParams(event) {
  if (!event || !['keydown', 'keyup'].includes(event.type) || typeof event.key !== 'string' ||
      typeof event.code !== 'string' || event.key.length > 32 || event.code.length > 32 ||
      !Number.isInteger(event.keyCode) || event.keyCode < 0 || event.keyCode > 255 ||
      !Number.isInteger(event.modifiers) || event.modifiers < 0 || event.modifiers > 15) {
    throw new Error('按键数据无效。');
  }
  // Only English typing is forwarded; shortcuts never reach the browser.
  if ((event.modifiers & 7) || !/^(Key[A-Z]|Digit[0-9]|Numpad[0-9]|Space|Backspace|ShiftLeft|ShiftRight|CapsLock|Comma|Period|Slash|Semicolon|Quote|BracketLeft|BracketRight|Backslash|Minus|Equal|Backquote)$/.test(event.code)) {
    throw new Error('目前仅支持英文输入、Shift 和退格；请在官网操作快捷键。');
  }
  const printable = /^[\x20-\x7e]$/.test(event.key);
  if (!printable && !['Shift', 'Backspace', 'CapsLock'].includes(event.key)) throw new Error('请切换到英文输入法。');
  const params = {
    type: event.type === 'keyup' ? 'keyUp' : printable ? 'keyDown' : 'rawKeyDown',
    key: event.key, code: event.code, windowsVirtualKeyCode: event.keyCode,
    modifiers: event.modifiers, autoRepeat: Boolean(event.repeat),
  };
  if (event.type === 'keydown' && printable) params.text = event.key;
  return params;
}

// This expression only reads the public test UI; it never reads login fields or tokens.
function snapshotExpression(lightweight=false, fullSpeech=false) { return `(() => {
  if (location.origin !== 'https://monkeytype.com' || location.pathname !== '/') return {ready:false, reason:'请回到 Monkeytype 测试页面。'};
  if (document.visibilityState === 'hidden') return {ready:false, backgroundSuspended:true, reason:'官网窗口已最小化或标签被隐藏，换词刷新已暂停。请恢复窗口并留在 VS Code 后面，不要最小化；再点击继续。'};
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const words = document.querySelector('#words');
  const active = words?.querySelector('.word.active');
  const input = document.querySelector('#wordsInput');
  const result = document.querySelector('#result');
  const level = ${lightweight ? 'undefined' : `(${readAccountLevel.toString()})()`};
  if (visible(result)) return {ready:false, finished:true, level, reason:'测试已结束；请查看官网保存结果。'};
  if (!visible(words) || !active || !input || input.disabled) return {ready:false, reason:'请在官网完成登录、关闭弹窗，并选择英文测试。'};
  const text = word => Array.from(word?.querySelectorAll('letter') || []).filter(l => !l.classList.contains('extra')).map(l => l.textContent).join('') || word?.textContent || '';
  const target = text(active);
  if (${lightweight}) return {ready:document.activeElement === input && /^[\\x20-\\x7e]+$/.test(target),reason:'官网输入区不可用，请回到英文测试并重新开始。'};
  const next = text(active.nextElementSibling);
  const elements = Array.from(words.querySelectorAll('.word'));
  const activeOffset = elements.indexOf(active);
  const indexOf = (el, fallback) => { const value=el.getAttribute('data-wordindex'); return value !== null && /^\\d+$/.test(value) ? Number(value) : fallback; };
  const wordIndex = indexOf(active, activeOffset);
  const identityKey=Symbol.for('codeType.testIdentity');
  const first=elements.find(el=>indexOf(el,-1)===0);
  let identity=globalThis[identityKey];
  if (!identity || first && first!==identity.first) {
    identity={first,sequence:(identity?.sequence || 0)+1}; globalThis[identityKey]=identity;
  }
  const testId=String(globalThis.performance?.timeOrigin || 0)+':'+identity.sequence;
  const buttons=Array.from(document.querySelector('[data-ui-element="testConfig"]')?.querySelectorAll('button') || []);
  const selected=button=>button.classList.contains('[--themable-button-text:var(--themable-button-active)]') || button.getAttribute('aria-pressed')==='true' || button.classList.contains('active');
  const mode=buttons.find(button=>['time','words','quote','custom','zen'].includes(button.textContent.trim()) && selected(button))?.textContent.trim();
  const amount=mode==='words' ? Number(buttons.find(button=>/^\\d+$/.test(button.textContent.trim()) && selected(button) && Array.from(button.parentElement?.querySelectorAll('button') || []).some(sibling=>sibling.textContent.trim()==='25'))?.textContent.trim()) : 0;
  const speechEnd=mode==='quote' ? indexOf(elements.at(-1),elements.length-1)+1 : amount>0 ? amount : null;
  const speechRevision=testId+':'+elements.length+':'+indexOf(elements.at(-1),elements.length-1)+':'+mode+':'+speechEnd;
  const speechStart=${fullSpeech ? '0' : 'Math.max(0,activeOffset-96)'};
  const speechWords=elements.slice(speechStart,${fullSpeech ? 'elements.length' : 'activeOffset+97'}).map((el,index)=>({index:indexOf(el,speechStart+index),text:text(el)}));
  const previewStart = Math.max(0,activeOffset-24);
  const preview = elements.slice(previewStart,activeOffset+36).map((el,offset)=>{
    const index=indexOf(el,previewStart+offset);
    const letters=Array.from(el.querySelectorAll('letter'));
    const original=letters.filter(letter=>!letter.classList.contains('extra'));
    const feedback=index<wordIndex && original.length ? {
      complete:true,
      errors:original.map((letter,i)=>letter.classList.contains('correct') ? -1 : i).filter(i=>i>=0),
      extra:letters.length-original.length,
    } : undefined;
    return { index, text:text(el), ...(feedback ? {feedback} : {}) };
  });
  if (!/^[\\x20-\\x7e]*$/.test(target)) return {ready:false, reason:'目前仅支持英文单词测试。'};
  return {ready: document.activeElement === input, target, next, wordIndex, preview, speechWords, speechEnd, speechRevision, testMode:mode, testId, level, typed: (input.value || '').replace(/^ /,''), reason: document.activeElement === input ? '' : '官网输入框失去焦点，请在官网点击单词区域后重新开始。'};
})()`; }
const SNAPSHOT=snapshotExpression();
const INPUT_GUARD=snapshotExpression(true);

class BrowserBridge extends EventEmitter {
  constructor() {
    super();
    this.pending = new Map();
    this.requests = new Map();
    this.nextId = 0;
    this.closed = true;
    this.round = 0;
    this.latestReceipt = undefined;
  }

  async launch(executable, profile, extraArgs = []) {
    fs.mkdirSync(profile, { recursive: true });
    this.closed = false;
    this.child = spawn(executable, [
      `--user-data-dir=${profile}`, '--remote-debugging-pipe', '--no-first-run',
      // Monkeytype updates the active word on animation frames; Windows occlusion must not suspend them.
      '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling', '--disable-features=CalculateNativeWinOcclusion',
      '--no-default-browser-check', ...extraArgs, 'https://monkeytype.com/',
    ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true });
    let buffer = '';
    this.child.stdio[4].setEncoding('utf8');
    this.child.stdio[4].on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\0')) !== -1) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!frame) continue;
        try { this.onMessage(JSON.parse(frame)); } catch { this.fail(new Error('浏览器返回了无效消息。')); }
      }
    });
    this.child.once('error', error => this.fail(error));
    this.child.once('exit', () => this.fail(new Error('官网浏览器已关闭。')));
    this.child.stdio[3].on('error', error => this.fail(error));
    this.child.stdio[4].on('error', error => this.fail(error));
    await this.call('Browser.getVersion');
  }

  call(method, params = {}, sessionId = undefined) {
    if (this.closed) return Promise.reject(new Error('官网浏览器未连接。'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`浏览器响应超时：${method}`));
      }, 8000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    });
  }

  onMessage(message) {
    if (message.id) {
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    } else if (message.sessionId === this.sessionId) {
      void this.onEvent(message).catch(error => this.emit('notice', error.message));
    }
  }

  async onEvent({ method, params }) {
    if (method === 'Network.requestWillBeSent' && isResultRequest(params.request)) {
      this.requests.set(params.requestId, { status: 0, round: this.round });
    } else if (method === 'Network.responseReceived' && this.requests.has(params.requestId)) {
      this.requests.get(params.requestId).status = params.response.status;
    } else if (method === 'Network.loadingFinished' && this.requests.has(params.requestId)) {
      const { status, round } = this.requests.get(params.requestId);
      this.requests.delete(params.requestId);
      const response = await this.call('Network.getResponseBody', { requestId: params.requestId }, this.sessionId);
      const body = response.base64Encoded ? Buffer.from(response.body, 'base64').toString('utf8') : response.body;
      const receipt = { ...resultReceipt(status, body), round };
      if (round === this.round) this.latestReceipt = receipt;
      this.emit('receipt', receipt);
    } else if (method === 'Network.loadingFailed' && this.requests.has(params.requestId)) {
      const { round } = this.requests.get(params.requestId);
      this.requests.delete(params.requestId);
      const receipt = { saved: false, round, text: '官网成绩请求失败，本地成绩已保留。' };
      if (round === this.round) this.latestReceipt = receipt;
      this.emit('receipt', receipt);
    }
  }

  async attach() {
    const { targetInfos } = await this.call('Target.getTargets');
    const target = targetInfos.find(t => t.type === 'page' && /^https:\/\/monkeytype\.com\//.test(t.url));
    if (!target) throw new Error('请在独立浏览器中打开 https://monkeytype.com/。');
    if (this.targetId !== target.targetId) {
      if (this.sessionId) await this.call('Target.detachFromTarget', { sessionId: this.sessionId }).catch(() => {});
      const attached = await this.call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      this.targetId = target.targetId;
      this.sessionId = attached.sessionId;
      this.requests.clear();
      await this.call('Network.enable', {}, this.sessionId);
    }
    return this.snapshot();
  }

  async evaluate(expression, awaitPromise=false) {
    const response = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, this.sessionId);
    if (response.exceptionDetails) throw new Error('无法读取官网页面，请检查页面是否已经加载。');
    return response.result.value;
  }

  snapshot(afterPaint=false) {
    if (!afterPaint) return this.evaluate(SNAPSHOT);
    // Monkeytype clears input synchronously but updates the active word in an animation frame.
    return this.evaluate(`new Promise(resolve => {
      const frame=requestAnimationFrame(()=>{clearTimeout(timer);resolve(${SNAPSHOT});});
      const timer=setTimeout(()=>{cancelAnimationFrame(frame);resolve(null);},100);
    })`,true);
  }

  speechSnapshot() {
    // Full-round text is read once per inventory change, outside the input queue.
    return this.evaluate(`new Promise((resolve,reject) => {
      const read=()=>{try {resolve(${snapshotExpression(false,true)});} catch(error) {reject(error);}};
      if (typeof requestIdleCallback==='function') requestIdleCallback(read,{timeout:250});
      else setTimeout(read,0);
    })`,true);
  }

  async captureResult() {
    return this.evaluate(`(() => { const readAccountLevel = ${readAccountLevel.toString()}; return (${readResult.toString()})(); })()`);
  }

  async clickTestButton(selector) {
    if (!['#nextTestButton', '#restartTestButtonWithSameWordset'].includes(selector)) throw new Error('不支持的测试操作。');
    const clicked = await this.evaluate(`(() => {
      if (location.origin !== 'https://monkeytype.com' || location.pathname !== '/' || document.visibilityState === 'hidden') return false;
      const result = document.querySelector('#result');
      const button = result?.querySelector(${JSON.stringify(selector)});
      if (!result?.getClientRects().length || !button?.getClientRects().length || button.disabled) return false;
      button.click(); return true;
    })()`);
    if (!clicked) throw new Error('官网尚未显示可用的下一场按钮，请等待结算完成。');
  }

  async waitForTest() {
    for (let attempt = 0; attempt < 60; attempt++) {
      const state = await this.snapshot();
      if (state.backgroundSuspended) throw new Error(state.reason);
      if (state.ready) return state;
      if (state.target) {
        await this.evaluate(`(() => {
          if(location.origin !== 'https://monkeytype.com' || location.pathname !== '/') return;
          if(Array.from(document.querySelectorAll('.modal, [role="dialog"]')).some(el=>el.getClientRects().length)) return;
          const input=document.querySelector('#wordsInput'); const current=document.activeElement;
          if (input && current !== input && !/^(INPUT|TEXTAREA|SELECT)$/.test(current?.tagName || '')) input.focus();
        })()`);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('官网未准备好，请检查是否有登录或设置弹窗。');
  }

  async nextTest(repeat = false) {
    if (!(await this.snapshot()).finished) throw new Error('当前测试尚未结束。');
    // Let the website finish its own submission; do not submit/retry scores ourselves.
    for (let i = 0; this.requests.size && i < 80; i++) await new Promise(resolve => setTimeout(resolve, 100));
    if (this.requests.size) throw new Error('官网仍在提交成绩，稍后再开始下一场。');
    await this.clickTestButton(repeat ? '#restartTestButtonWithSameWordset' : '#nextTestButton');
    const state = await this.waitForTest();
    this.round++;
    this.latestReceipt = undefined;
    return state;
  }

  async applySettings(settings) {
    const url = settingsUrl(settings);
    for (let i = 0; this.requests.size && i < 80; i++) await new Promise(resolve => setTimeout(resolve, 100));
    if (this.requests.size) throw new Error('官网仍在提交成绩，请稍后再更改设置。');
    this.round++;
    this.latestReceipt = undefined;
    await this.call('Page.navigate', { url }, this.sessionId);
    // Navigation may initially still expose the previous document.
    for (let i = 0; i < 60; i++) {
      if (await this.evaluate(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await this.waitForTest();
    if (settings.mode === 'quote') {
      const clicked = await this.evaluate(`(() => {
        const root=document.querySelector('[data-ui-element="testConfig"]');
        const button=Array.from(root?.querySelectorAll('button') || []).find(b => b.textContent.trim() === ${JSON.stringify(settings.amount)} && b.getClientRects().length && !b.disabled);
        if (!button) return false; button.click(); return true;
      })()`);
      if (!clicked) throw new Error('官网的引文长度选项暂不可用。');
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    return this.waitForTest();
  }

  async sendKey(event) {
    const params = keyParams(event);
    // Check focus immediately before input; never route typing to account/password fields.
    const state = await this.evaluate(INPUT_GUARD);
    if (!state.ready) throw new Error(state.reason);
    await this.call('Input.dispatchKeyEvent', params, this.sessionId);
    if (event.type==='keydown') return this.snapshot(event.key===' ' || event.key==='Backspace');
  }

  async release(keys) {
    for (const event of keys) {
      await this.call('Input.dispatchKeyEvent', keyParams({ ...event, type: 'keyup', repeat: false }), this.sessionId).catch(() => {});
    }
  }

  async show() {
    if (!this.sessionId) await this.attach();
    await this.call('Page.bringToFront', {}, this.sessionId);
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.emit('disconnected', error.message);
  }

  async close() {
    const child = this.child;
    const exited = child && child.exitCode === null && child.signalCode === null
      ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve();
    if (!this.closed) await this.call('Browser.close').catch(() => {});
    let timer;
    await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 3000); })]);
    clearTimeout(timer);
    this.fail(new Error('连接已关闭。'));
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
  }
}

module.exports = { BrowserBridge, findBrowser, launchLogin, keyParams, resultReceipt, isResultRequest, SNAPSHOT, INPUT_GUARD };
