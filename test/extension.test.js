const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { loadExtension, baseVscode, uri } = require('./helpers');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('practice uses a snapshot, forwards physical events, halts stale input, and restores original document', async () => {
  const calls = [];
  let browser;
  let practiceProfile;
  let loginProfile;
  let loginExecutable;
  const loginProcess = { exitCode: null, signalCode: null };
  class FakeBrowser extends EventEmitter {
    constructor() { super(); browser = this; this.round = 0; this.state = { ready: true, target: 'hello', next: 'world', typed: '', wordIndex:20,
      preview:'previous hello world through people make time work point first last'.split(' ').map((text,index)=>({text,index:index+19})) }; }
    async launch(executable, profile) { this.closed = false; practiceProfile = profile; }
    async attach() { return this.snapshot(); }
    async snapshot() { return this.state; }
    async waitForTest() { return this.snapshot(); }
    async captureResult() { return { metrics: { wpm: '25', accuracy: '95%', raw: '26', characters: '149/2/1/0', consistency: '13%', time: '01:12', testType: 'quote medium english' } }; }
    async nextTest(repeat) { calls.push({ type: 'next', repeat }); this.round++; this.state = this.nativeState ? { ...this.nativeState, testId: 'native-' + this.round } : { ready: true, target: 'world', next: 'hello', typed: '' }; return this.state; }
    async matchesDictionary() { return !!this.nativeState; }
    async applyDictionary(file, options) {
      calls.push({ type: 'dictionary-import', file, options });
      this.nativeState = { ready: true, target: 'one', next: 'two', typed: '', wordIndex: 0, testMode: 'custom', testId: 'native-' + (++this.round),
        customMode: options.order, customLimit: { mode: 'section', value: options.size }, speechEnd: 2,
        speechWords: [{index:0,text:'one'}, {index:1,text:'two'}] };
      this.state = this.nativeState; return this.state;
    }
    async applySettings(settings) {
      calls.push({ type: 'settings', settings });
      if (settings.mode !== 'custom') { this.nativeState = undefined; return this.nextTest(false); }
      this.round++;
      this.state = { ready: true, target: settings.text[0], next: settings.text[1], typed: '', wordIndex: 0,
        testId: `custom-${this.round}`, testMode: 'custom', speechEnd: settings.text.length,
        speechWords: settings.text.map((text, index) => ({ text, index })) };
      return this.state;
    }
    async sendKey(event) {
      calls.push(event);
      if (event.type !== 'keydown') return;
      const typed = this.state.typed || '';
      this.state = event.key === ' '
        ? {...this.state, typed:'', wordIndex:(this.state.wordIndex || 0)+1, target:this.state.next || this.state.target, next:this.state.target}
        : {...this.state, typed:event.key==='Backspace' ? typed.slice(0,-1) : typed+event.key};
      return this.state;
    }
    async release(events) { calls.push(...events.map(event => ({ ...event, type: 'keyup' }))); }
    async close() { this.closed = true; }
  }
  let source = "const secret = '<script>never send this</script>';\n";
  const document = { fileName: 'private.js', languageId: 'javascript', uri: uri('private.js'), isClosed: false, isDirty: true, getText: () => source };
  const original = document.getText();
  const commands = {};
  const messages = [];
  const errors = [];
  const providerCalls=[];
  let receive, dispose, viewChanged, windowChanged, restored, current;
  const vscode = baseVscode();
  const stored = new Map();
  stored.set('practicePreferences',{displayMode:'statusbar',speechEnabled:false,dockFont:16});
  const updates = [];
  const statusItems = [];
  const globalState = { get: key => stored.get(key), update: async (key, value) => { updates.push({ key, value }); value === undefined ? stored.delete(key) : stored.set(key, value); } };
  Object.assign(vscode, {
    StatusBarAlignment: { Right: 1 }, ViewColumn: { One: 1 },
    commands: { registerCommand: (name, callback) => { commands[name] = callback; return { dispose() {} }; }, executeCommand: name => {if(name==='vscode.executeCompletionItemProvider') providerCalls.push(name);return commands[name]?.();} },
    window: {
      onDidChangeWindowState: callback => { windowChanged=callback; return {dispose(){}}; },
      activeTextEditor: { document, viewColumn: 1, options:{tabSize:4} },
      createStatusBarItem: () => { const item={show(){this.visible=true},hide(){this.visible=false},dispose(){this.visible=false}}; statusItems.push(item); return item; },
      showErrorMessage: text => errors.push(text),
      showInformationMessage: text => messages.push({ type: 'information', text }),
      showTextDocument: async doc => { restored = doc; },
      createWebviewPanel: () => {
        current = {
          active: true,
          webview: { cspSource: 'vscode-webview:', asWebviewUri: value => value.toString(), postMessage: message => { messages.push(message); return Promise.resolve(true); }, onDidReceiveMessage: callback => { receive = callback; } },
          onDidChangeViewState: callback => { viewChanged = callback; },
          onDidDispose: callback => { dispose = callback; },
          dispose: () => dispose(), reveal() {},
        };
        return current;
      },
    },
  });
  const extension = loadExtension(vscode, {
    BrowserBridge: FakeBrowser, findBrowser: () => 'mock-browser',
    launchLogin: async (executable, profile) => { loginExecutable = executable; loginProfile = profile; return loginProcess; },
  });
  const context = { subscriptions: [], extensionUri: uri(path.resolve(__dirname, '..')), globalStorageUri: uri('.test-output/mock-profile'), globalState };
  extension.activate(context);
  try {
    await commands['codeType.connect']();
    assert.equal(loginExecutable, 'mock-browser');
    await commands['codeType.start']();
    assert.ok(errors.some(text => text.includes('关闭该窗口')));
    assert.equal(browser, undefined, 'do not attach debugging while ordinary login is open');
    errors.length = 0;
    loginProcess.exitCode = 0;
    await commands['codeType.start']();
    assert.equal(practiceProfile, loginProfile, 'reuse the browser-owned login state in the same dedicated profile');
    assert.deepEqual(errors, []);
    assert.ok(current.webview.html.includes("default-src 'none'"));
    assert.ok(!current.webview.html.includes('never send this'));
    const session = current.webview.html.match(/data-session="([^"]+)"/)[1];
    const emit = message => receive({ session, ...message });
    emit({ type: 'ready' });
    assert.equal(messages.filter(m=>m.type==='code').at(-1).tabSize,4,'uses editor-detected indentation width instead of the global default');
    assert.equal(statusItems.at(-1).visible,true,'statusbar mode uses a native VS Code status item');
    assert.ok(statusItems.at(-1).text.includes('hello'));
    assert.equal(statusItems.at(-1).text,'[0/5] [hello]  world  through  people  make  time  work  point','counter precedes the fixed eight-word group');
    emit({type:'preferences',displayMode:'statusbar',speechEnabled:false,statusbarWords:4});
    assert.equal(statusItems.at(-1).text,'[0/5] [hello]  world  through  people');
    assert.ok(statusItems.at(-1).tooltip.includes('hello world through people'));
    emit({type:'preferences',displayMode:'statusbar',speechEnabled:false,showProgress:false});
    assert.equal(statusItems.at(-1).text,'[hello]  world  through  people','progress can be hidden in native statusbar');
    emit({type:'preferences',displayMode:'statusbar',speechEnabled:false,showProgress:true});
    emit({type:'preferences',displayMode:'statusbar',speechEnabled:false,statusbarWords:8});
    emit({ type: 'arm' });
    await delay(10);
    assert.ok(messages.some(m => m.type === 'armed'));
    const firstState=browser.state;
    browser.state={...firstState,wordIndex:21,target:'world',next:'through',typed:'w'};
    emit({type:'arm'});
    await delay(10);
    assert.equal(statusItems.at(-1).text,'[1/5] hello  [world]  through  people  make  time  work  point','completed words remain until the whole group is done');
    assert.equal(statusItems.at(-1).color.id,'errorForeground','missing previous letters remain an error after advancing');
    assert.ok(statusItems.at(-1).tooltip.includes('错词：hello'));
    browser.state={...firstState,typed:'hello'};
    emit({type:'arm'});
    await delay(10);
    browser.state={...firstState,wordIndex:21,target:'world',typed:'world'};
    emit({type:'arm'});
    await delay(10);
    assert.equal(statusItems.at(-1).color,undefined,'correcting the word clears statusbar error styling');
    browser.state={...firstState,wordIndex:28,target:'first',next:'last',typed:''};
    emit({type:'arm'});
    await delay(10);
    assert.equal(statusItems.at(-1).text,'[0/5] [first]  last','the next group starts only at the group boundary');
    browser.state={...firstState,wordIndex:27,target:'point',next:'first',typed:''};
    emit({type:'arm'});
    await delay(10);
    assert.equal(statusItems.at(-1).text,'[0/5] hello  world  through  people  make  time  work  [point]','backspacing across a group restores its context');
    browser.state=firstState;
    emit({type:'arm'});
    await delay(10);
    const event = { type: 'keydown', key: 'h', code: 'KeyH', keyCode: 72, modifiers: 0 };
    const originalSnapshot=browser.snapshot;
    let releasePoll;
    const pollStarted=new Promise(resolve=>{
      browser.snapshot=()=>new Promise(done=>{releasePoll=()=>done({...firstState,typed:''});resolve();});
    });
    await pollStarted;
    emit({ type: 'key', sentAt: Date.now(), event });
    emit({ type: 'key', sentAt: Date.now(), event: { ...event, type: 'keyup' } });
    await delay(10);
    assert.deepEqual(calls.map(e => e.type), ['keydown', 'keyup']);
    assert.equal(messages.filter(m=>m.type==='state').at(-1).typed,'h','feedback arrives with the key response, before the periodic poll');
    browser.snapshot=originalSnapshot;
    releasePoll();
    await delay(0);
    assert.equal(messages.filter(m=>m.type==='state').at(-1).typed,'h','an older poll cannot overwrite the new key feedback');
    await delay(20);
    assert.ok(messages.some(m => m.type === 'code' && m.html.includes('c')));
    await delay(10);
    assert.ok(updates.some(item => item.value?.progress === 1), 'typing progress is persisted');
    emit({ type: 'key', sentAt: Date.now() - 1000, event });
    await delay(10);
    assert.equal(calls.length, 2, 'stale input must not replay');
    assert.ok(messages.some(m => m.type === 'halt' && m.text.includes('250ms')));
    emit({ type: 'arm' });
    await delay(10);
    emit({ type: 'key', sentAt: Date.now(), event: {...event, key:'e', code:'KeyE', keyCode:69} });
    await delay(10);
    current.active = false;
    viewChanged();
    await delay(10);
    assert.equal(messages.filter(m=>m.type==='view-active').at(-1).active,false);
    assert.equal(calls.at(-1).type, 'keyup', 'losing the editor must release held keys');
    current.active = true;
    windowChanged({focused:false});
    assert.equal(messages.filter(m=>m.type==='view-active').at(-1).active,false);
    windowChanged({focused:true});
    assert.equal(messages.filter(m=>m.type==='view-active').at(-1).active,true);
    browser.state = { ready: false, finished: true, reason: 'finished' };
    for (let i=0;i<100 && !messages.some(m=>m.type==='report' && m.localStatus==='已自动保存到本地');i++) await delay(20);
    assert.ok(messages.some(m=>m.type==='report' && m.metrics.wpm==='25' && m.localStatus==='已自动保存到本地'),'result is displayed and archived without asking');
    browser.emit('receipt', { round: 0, saved: true, xp: 12, text: '官网已保存本次成绩，经验 +12。' });
    await commands['codeType.result']();
    assert.ok(messages.some(m => m.type === 'report' && m.accountStatus.includes('+12')));
    assert.equal(messages.filter(m=>m.type==='report').at(-1).xp,12);
    emit({type:'next-test'});
    for(let i=0;i<40 && !messages.some(m=>m.type==='round-reset');i++) await delay(10);
    assert.ok(calls.some(m=>m.type==='next' && m.repeat===false));
    assert.ok(messages.some(m=>m.type==='round-reset'));
    assert.ok([...stored.values()].some(value=>value.progress===2),'Next test preserves code progress');
    emit({type:'repeat-test'});
    await delay(20);
    assert.ok(calls.some(m=>m.type==='next' && m.repeat===true));
    assert.ok([...stored.values()].some(value=>value.progress===2),'Repeat test also preserves code progress');
    const reportCount=messages.filter(m=>m.type==='report').length;
    browser.emit('receipt',{round:0,saved:false,text:'old-round failure'});
    await delay(20);
    assert.equal(messages.filter(m=>m.type==='report').length,reportCount,'late old-round receipt cannot overwrite the new round');
    emit({type:'settings',settings:{mode:'words',amount:25,language:'english',punctuation:false,numbers:false}});
    await delay(30);
    assert.ok(calls.some(m=>m.type==='settings'));
    assert.ok([...stored.values()].some(value=>value.progress===2),'settings preserve code progress');
    await commands['codeType.stop']();
    await delay(10);
    assert.equal(restored, document);
    assert.equal(document.getText(), original);
    assert.equal(document.isDirty, true);
    assert.ok(stored.size > 0, 'unfinished progress remains for the same file');
    await extension.deactivate();
    extension.activate(context);
    await commands['codeType.start']();
    const emitCurrent = message => receive({ session: current.webview.html.match(/data-session="([^"]+)"/)[1], ...message });
    emitCurrent({type:'ready'});
    assert.ok(messages.filter(m=>m.type==='code').at(-1).html.includes('co'),'reopening after reactivation restores progress');
    assert.equal(messages.filter(m=>m.type==='code').at(-1).reveal,true);
    await commands['codeType.stop']();
    document.uri=uri('other.js');
    await commands['codeType.start']();
    emitCurrent({type:'ready'});
    assert.equal(messages.filter(m=>m.type==='code').at(-1).html,'','another file with identical contents has independent progress');
    await commands['codeType.stop']();
    document.uri=uri('private.js');
    source = 'function differentFileContents() {}';
    await commands['codeType.start']();
    emitCurrent({type:'ready'});
    assert.equal(messages.filter(m=>m.type==='code').at(-1).html,'','changed content does not receive the old offset');
    await commands['codeType.stop']();
    source = original;
    await commands['codeType.start']();
    emitCurrent({type:'ready'});
    assert.ok(messages.filter(m=>m.type==='code').at(-1).html.includes('co'));
    await commands['codeType.resetProgress']();
    assert.equal(messages.filter(m=>m.type==='code').at(-1).html,'');
    await commands['codeType.stop']();
    // Relay uses local snapshots only; changing source files never restarts the website test.
    source = 'ab';
    const nextDocument = { fileName:'next.py', languageId:'python', uri:uri('next.py'), getText:()=> 'xyz' };
    let selection = [nextDocument.uri, nextDocument.uri, uri('missing.js')];
    const warnings = [];
    vscode.Uri.parse = uri;
    vscode.Uri.file = uri;
    vscode.ConfigurationTarget = { Global: 1 };
    let relaySetting;
    const originalConfiguration = vscode.workspace.getConfiguration;
    vscode.workspace.getConfiguration = (...args) => ({
      get: name => name === 'relayFiles' ? relaySetting : originalConfiguration(...args).get(name),
      inspect: () => ({}),
      update: async (name, value) => { relaySetting = value; },
    });
    stored.set('relayFiles', ['old-queue.py']);
    vscode.window.showOpenDialog = async () => selection;
    vscode.window.showWarningMessage = text => warnings.push(text);
    vscode.workspace.openTextDocument = async address => {
      if (path.basename(address.fsPath) === nextDocument.uri.toString()) return nextDocument;
      throw new Error('missing');
    };
    selection = selection.map(file => uri(path.resolve(file.fsPath)));
    await commands['codeType.selectRelayFiles']();
    assert.equal(relaySetting.length, 2, 'picker writes deduplicated configuration paths');
    await commands['codeType.start']();
    emitCurrent({type:'ready'});
    emitCurrent({type:'arm'});
    await delay(10);
    const roundsBefore = browser.round;
    const press = async () => {
      const state = messages.filter(m=>m.type==='state').at(-1);
      const key = state.target[state.typed?.length || 0] || ' ';
      const correctEvent = {...event, key, code:key===' ' ? 'Space' : `Key${key.toUpperCase()}`, keyCode:key.toUpperCase().charCodeAt(0)};
      emitCurrent({type:'key',sentAt:Date.now(),event:correctEvent});
      emitCurrent({type:'key',sentAt:Date.now(),event:{...correctEvent,type:'keyup'}});
      await delay(25);
    };
    await press(); await press(); await press();
    let frame = messages.filter(m=>m.type==='code').at(-1);
    assert.equal(frame.fileName,'next.py');
    assert.equal(frame.language,'python');
    assert.equal(frame.html,'x');
    assert.equal(frame.relayCount,2,'duplicate and unavailable files are not added');
    assert.ok(warnings.length>0);
    assert.equal(browser.round,roundsBefore,'relay does not restart the actual test');
    await commands['codeType.stop']();
    await extension.deactivate();
    extension.activate(context);
    await commands['codeType.start']();
    emitCurrent({type:'ready'});
    frame = messages.filter(m=>m.type==='code').at(-1);
    assert.equal(frame.fileName,'next.py','reopening skips the completed first file');
    assert.equal(frame.html,'x','next file has its own persisted position');
    selection = undefined;
    await commands['codeType.selectRelayFiles']();
    assert.equal(relaySetting.length,2,'canceling the picker preserves the configured queue');
    await commands['codeType.clearRelayFiles']();
    assert.equal(stored.has('relayFiles'),false);
    assert.deepEqual(relaySetting, [], 'clear overrides both configured and legacy queues');
    frame = messages.filter(m=>m.type==='code').at(-1);
    assert.equal(frame.relayCount,1);
    assert.equal(frame.html,'x','clearing the queue keeps current progress');
    await commands['codeType.stop']();
    assert.equal(restored,document);
    assert.equal(providerCalls.length,0,'default practice never invokes language providers that can churn diagnostics');
    assert.equal(nextDocument.getText(),'xyz','relay never edits the real file');
    await commands['codeType.start']();
    emitCurrent({type:'preferences',displayMode:'dock',speechEnabled:false,speechVolume:240,statusbarWords:16,inlineWords:8,dockFont:20,dockLines:2,dockStyle:'standard',dockPosition:'center',dockWidth:420,hoverOnly:true,hideOnBlur:true,showProgress:false,showDockCaret:false,screenCentered:true});
    await delay(10);
    assert.equal(statusItems.at(-1).visible,false);
    await commands['codeType.stop']();
    await commands['codeType.start']();
    emitCurrent({type:'ready'});
    assert.equal(messages.filter(m=>m.type==='preferences').at(-1).displayMode,'dock','display and voice choices survive reopening');
    assert.equal(messages.filter(m=>m.type==='preferences').at(-1).dockPosition,'center');
    assert.equal(messages.filter(m=>m.type==='preferences').at(-1).dockWidth,420);
    assert.equal(messages.filter(m=>m.type==='preferences').at(-1).hoverOnly,true);
    assert.equal(messages.filter(m=>m.type==='preferences').at(-1).hideOnBlur,true);
    assert.equal(messages.filter(m=>m.type==='preferences').at(-1).showProgress,false);
    assert.equal(messages.filter(m=>m.type==='preferences').at(-1).showDockCaret,false);
    assert.equal(messages.filter(m=>m.type==='preferences').at(-1).screenCentered,true);
    assert.equal(messages.filter(m=>m.type==='preferences').at(-1).dockFont,20);
    assert.equal(messages.filter(m=>m.type==='preferences').at(-1).dockLines,2);
    assert.equal(messages.filter(m=>m.type==='preferences').at(-1).dockStyle,'standard');
    assert.equal(messages.filter(m=>m.type==='preferences').at(-1).statusbarWords,16);
    assert.equal(messages.filter(m=>m.type==='preferences').at(-1).inlineWords,8);
    assert.equal(messages.filter(m=>m.type==='preferences').at(-1).speechEnabled,false);
    assert.equal(messages.filter(m=>m.type==='preferences').at(-1).speechVolume,240);
    await commands['codeType.stop']();
    source='a\n    b';
    await commands['codeType.start']();
    emitCurrent({type:'ready'}); emitCurrent({type:'arm'});
    await delay(10);
    await press(); await press();
    assert.equal(messages.filter(m=>m.type==='code').at(-1).html,'a\n    ','one key reveals newline and indentation');
    emitCurrent({type:'key',sentAt:Date.now(),event:{...event,key:'Backspace',code:'Backspace',keyCode:8}});
    await delay(25);
    assert.equal(messages.filter(m=>m.type==='code').at(-1).html,'a','backspace removes the same display step');
    await press();
    await commands['codeType.stop']();
    await commands['codeType.start']();
    emitCurrent({type:'ready'});
    assert.equal(messages.filter(m=>m.type==='code').at(-1).html,'a\n    ','reopening restores the source offset after grouped whitespace');
    await commands['codeType.stop']();
    source = 'a\n    b<>c';
    browser.state = {ready:true, target:'hello', typed:'', wordIndex:0};
    const type = async key => {
      const next = {...event, key, code:key==='Backspace' ? key : `Key${key.toUpperCase()}`};
      emitCurrent({type:'key',sentAt:Date.now(),event:next});
      emitCurrent({type:'key',sentAt:Date.now(),event:{...next,type:'keyup'}});
      await delay(30);
    };
    const code = () => messages.filter(m=>m.type==='code').at(-1);
    await commands['codeType.start']();
    emitCurrent({type:'ready'}); emitCurrent({type:'arm'});
    await delay(10);
    await type('h');
    assert.equal(code().html, 'a', 'correct practice input reveals the original code');
    await type('x');
    assert.equal(code().html, 'ax', 'a typo replaces the entire newline and indentation step');
    assert.equal(code().lines, 1, 'line count follows the actual displayed code');
    await type('l');
    assert.equal(code().html, 'axb', 'later correct input does not repair an earlier typo');
    await commands['codeType.stop']();
    await commands['codeType.start']();
    emitCurrent({type:'ready'}); emitCurrent({type:'arm'});
    await delay(10);
    assert.equal(code().html, 'axb', 'reopening preserves both typo content and source progress');
    await type('Backspace');
    await type('Backspace');
    assert.equal(code().html, 'a', 'backspacing removes the wrong display step');
    await type('e');
    assert.equal(code().html, 'a\n    ', 'correcting the typo restores grouped indentation');
    await type('b');
    assert.equal(code().html, 'a\n    ?', 'a wrong key matching the source still produces a visible typo');
    await type('<');
    await type('&');
    assert.equal(code().html, 'a\n    ??&amp;', 'typos are escaped before rendering HTML');
    assert.equal(document.getText(), source, 'typing mistakes never modify the real document');
    await commands['codeType.resetProgress']();
    assert.equal(code().html, '', 'reset clears displayed mistakes');
    await commands['codeType.stop']();
    await commands['codeType.start']();
    emitCurrent({type:'ready'});
    assert.equal(code().html, '', 'reset also clears persisted mistakes');
    await commands['codeType.stop']();
    stored.set('practicePreferences',{displayMode:'statusbar',speechEnabled:false,statusbarWords:12});
    await commands['codeType.start']();
    emitCurrent({type:'ready'});
    assert.equal(messages.filter(m=>m.type==='preferences').at(-1).displayMode,'dock','old native statusbar mode migrates to the custom reading strip once');
    assert.equal(stored.get('practicePreferences').dockFont,13);
    assert.equal(stored.get('practicePreferences').dockStyle,'compact');
    assert.equal(stored.get('practicePreferences').statusbarWords,12);
    await commands['codeType.stop']();
    for (const displayMode of ['corner','dock']) {
      stored.set('practicePreferences',{displayMode,dockFont:16,dockLines:2,dockStyle:'hover',cornerWidth:420});
      await commands['codeType.start']();
      emitCurrent({type:'ready'});
      const migrated=messages.filter(m=>m.type==='preferences').at(-1);
      assert.equal(migrated.displayMode,'dock');
      assert.equal(migrated.dockPosition,displayMode==='corner'?'right':'full');
      assert.equal(migrated.dockLines,2);
      assert.equal(migrated.dockFont,16);
      assert.equal(migrated.dockStyle,displayMode==='corner'?'standard':'compact');
      assert.equal(migrated.hoverOnly,displayMode==='dock');
      assert.equal(migrated.hideOnBlur,displayMode==='corner');
      assert.equal('cornerWidth' in migrated,false);
      await commands['codeType.stop']();
    }
    const { DictionaryStore, parseEntries } = require('../src/dictionaries');
    const dictionaries = new DictionaryStore(path.join(context.globalStorageUri.fsPath, 'dictionaries'));
    const terms = 'one two three four five six seven eight nine ten eleven twelve red blue green black white yellow orange purple violet';
    await dictionaries.save({ id: 'local-test', name: 'Test words', kind: 'words', ...parseEntries(terms, 'words') });
    vscode.ProgressLocation = { Notification: 1 };
    vscode.window.withProgress = (_options, work) => work();
    vscode.window.showQuickPick = async items => items.find(item => item.id === 'local-test' || item.value === 20 || item.value === 'shuffle');
    await commands['codeType.dictionaries']();
    assert.equal(stored.get('dictionarySelection').id, 'local-test', 'selection persists before practice opens');
    await commands['codeType.start']();
    emitCurrent({ type: 'ready' });
    const latest = () => messages.filter(m => m.type === 'state').at(-1);
    assert.equal(latest().wordPractice, true);
    assert.equal(latest().dictionary.order, 'shuffle');
    assert.equal(latest().dictionary.size, 20);
    assert.equal(latest().target, 'one');
    const importsBefore = calls.filter(c=>c.type==='dictionary-import').length;
    for (const action of ['next-test', 'repeat-test']) {
      browser.state = { ready: false, finished: true };
      const before = browser.round;
      emitCurrent({ type: action });
      for(let i=0;i<50 && browser.round===before;i++) await delay(10);
      assert.equal(calls.at(-1).type, 'next', 'use native website test buttons');
      assert.equal(calls.at(-1).repeat, action==='repeat-test');
      assert.equal(latest().wordPractice, true);
      assert.equal(calls.filter(c=>c.type==='dictionary-import').length, importsBefore, 'Next and Repeat never reimport text');
    }
    await commands['codeType.stop']();
    await commands['codeType.start']();
    emitCurrent({ type: 'ready' });
    assert.equal(latest().target, 'one');
    assert.equal(calls.filter(c=>c.type==='dictionary-import').length, importsBefore, 'reopening keeps website settings and current text');
    emitCurrent({ type: 'settings', settings: { mode: 'words', amount: 25, language: 'english', punctuation: false, numbers: false } });
    for (let i=0;i<50 && stored.has('dictionarySelection');i++) await delay(10);
    assert.equal(stored.has('dictionarySelection'), false, 'official settings leave library mode');
    assert.equal(latest().wordPractice, undefined);
  } finally { await extension.deactivate(); }
});
