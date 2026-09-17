(() => {
  const vscode = acquireVsCodeApi();
  const session = document.body.dataset.session;
  const editor = document.getElementById('editor');
  const resume = document.getElementById('resume');
  const code = document.getElementById('code');
  const caret = document.getElementById('caret');
  let armed = false;
  let finished = false;
  let busy = false;
  let reportReceived = false;
  const held = new Set();
  const send = (type, data = {}) => vscode.postMessage({ type, session, ...data });
  const promptPanel = document.getElementById('prompt-panel');
  const wordList = document.getElementById('word-list');
  const wordWindow = document.getElementById('word-window');
  const wordCache = new Map();
  const wordHistory = new Map();
  let promptState;
  let pageKey = '';
  let speechEnabled = true;
  let speechId = 0;
  let spokenWord;
  let speechMode='word';
  let activeSpeechMode;
  const effectiveSpeechMode=()=>promptState?.testMode==='words' ? 'word' : speechMode;
  let spokenSentenceStart=-1;
  let activeSentence;
  let hybridWordPhase=false;
  let speechEpoch;
  let replayPending=false;
  let audio;
  let playedSpeechId;
  let hybridTimer;
  let speechVolume=100;
  let smartSpeech=false, smartTimer, lastInputAt=0;
  let requestedRange, playingRange;
  let speechQueue=[], activeTask;
  let speechPreparation={}, speechFailure='', audioReceived=false;
  const completedSentences=new Set();
  let audioContext, audioGain, audioSource, nativeUtterance;
  function renderSpeechStatus() {
    const status=document.getElementById('tts-status');
    status.hidden=finished;
    const prep=speechPreparation, unit=prep.unit==='word' ? '词' : '段';
    let label=!speechEnabled ? '朗读已关闭' : !armed ? '语音就绪' : activeTask ?
      playingRange ? '朗读中' : audioReceived ? '加载音频...' : '等待模型...' : '等待朗读';
    if (speechEnabled) {
      if (speechFailure) label='朗读失败';
      if (speechQueue.length) label+=` · 排队 ${speechQueue.length}`;
      if (prep.total) label+=prep.ready===prep.total ? ` · 已准备 ${prep.total} ${unit}` : ` · ${prep.paused ? '已暂停' : '预生成'} ${prep.ready}/${prep.total} ${unit}`;
      else if (prep.reading) label+=' · 读取整局文本';
      else if (prep.system) label+=' · 系统语音';
      if (prep.failed) label+=` · ${prep.failed} 项失败`;
      if (prep.contextError) label+=' · 文本读取失败';
    }
    if (status.textContent!==label) status.textContent=label;
    status.title=speechFailure || prep.contextError || prep.error || label;
    status.classList.toggle('error',Boolean(speechEnabled && (speechFailure || prep.failed || prep.contextError)));
    const retry=document.getElementById('tts-retry');
    retry.hidden=finished || !speechEnabled || !(prep.failed || prep.contextError);
    retry.disabled=Boolean(prep.paused);
  }
  function wordToRead() {
    if (!promptState?.target) return;
    let index=promptState.wordIndex ?? 0, text=promptState.target;
    const typed=promptState.typed || '', mode=effectiveSpeechMode();
    if (typed===text && !(mode==='hybrid' && smartSpeech)) {
      if (mode==='hybrid' && index+1>=promptState.sentence?.end) return;
      const next=wordCache.get(index+1);
      if (next) return {index:index+1,text:next};
    }
    if (typed===text) return;
    return {index,text};
  }
  function markSpeech() {
    for (const word of document.querySelectorAll('.prompt-word,.inline-word')) {
      const index=Number(word.dataset.index);
      word.classList.toggle('speaking',Boolean(playingRange && index>=playingRange.start && index<playingRange.end));
    }
    renderSpeechStatus();
  }
  function speechStarted(id) {
    if (id!==speechId || !armed || !speechEnabled) return;
    playingRange=requestedRange;
    markSpeech();
  }
  function updateVolume() {
    if (audioGain) audioGain.gain.value=speechVolume/100;
    if (nativeUtterance) nativeUtterance.volume=Math.min(1,speechVolume/100);
  }
  function stopSpeech(clearQueue=true) {
    speechId++;
    if (clearQueue) {
      for (const task of [activeTask,...speechQueue]) if (task?.unit==='sentence') completedSentences.add(task.sentenceId);
      speechQueue=[];
    }
    activeTask=undefined;
    audioReceived=false;
    requestedRange=playingRange=undefined; markSpeech();
    clearTimeout(smartTimer); smartTimer=undefined;
    clearTimeout(hybridTimer); hybridTimer=undefined;
    window.speechSynthesis?.cancel();
    if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); audio = undefined; }
    audioSource?.disconnect(); audioSource=undefined; nativeUtterance=undefined;
    send('speech-cancel');
  }
  function playQueuedSpeech() {
    if (activeTask || hybridTimer || !speechQueue.length || !armed || !speechEnabled) return;
    const task=speechQueue.shift();
    stopSpeech(false);
    activeTask=task;
    speechFailure=''; audioReceived=false;
    requestedRange={start:task.start,end:task.end};
    renderSpeechStatus();
    send('speech',{id:speechId,...task,epoch:promptState.speechEpoch});
  }
  function speakCurrent(replay=false) {
    if (!armed || !speechEnabled || !promptState?.target || promptState.finished || promptState.ready===false) return;
    const mode=effectiveSpeechMode();
    if (activeSpeechMode!==mode) {
      stopSpeech(); spokenWord=undefined; spokenSentenceStart=-1; activeSentence=undefined;
      completedSentences.clear();
      activeSpeechMode=mode;
    }
    if (replay) { stopSpeech(); spokenWord=undefined; }
    if (mode!=='word') {
      let sentence=promptState.sentence;
      if (mode==='hybrid' && !replay && sentence && promptState.wordIndex===sentence.end-1 && promptState.typed===promptState.target) {
        sentence=promptState.nextSentence;
        if (!sentence) return;
      }
      // A single-word segment waits for its typing position instead of adding a sentence pass.
      if (!replay && sentence?.wordCount<2 && sentence.start>promptState.wordIndex) return;
      if (activeSentence!==sentence?.id) {
        activeSentence=sentence?.id; spokenWord=undefined;
      }
      if (!sentence) { document.getElementById('speech-status').textContent='等待官网后续句子文本'; return; }
      hybridWordPhase=!replay && (sentence.wordCount<2 || completedSentences.has(sentence.id));
      if (mode==='sentence' && sentence.wordCount<2 && !replay) return;
      if (replay || mode==='sentence' || !hybridWordPhase) {
        if (!replay && sentence.start<=spokenSentenceStart) return;
        spokenSentenceStart=Math.max(spokenSentenceStart,sentence.start);
        document.getElementById('speech-status').textContent='';
        speechQueue.push({text:sentence.text,unit:'sentence',sentenceId:sentence.id,start:sentence.start,end:sentence.end});
        renderSpeechStatus();
        playQueuedSpeech();
        return;
      }
    }
    const candidate=wordToRead();
    if (!candidate) return;
    const {index,text}=candidate;
    const word = `${index}:${text}`;
    if (word === spokenWord) return;
    clearTimeout(smartTimer); smartTimer=undefined;
    if (mode==='hybrid' && smartSpeech) {
      const typed=promptState.typed || '';
      const remaining=900-(Date.now()-lastInputAt);
      if (promptState.target.startsWith(typed)) {
        if (typed===promptState.target) return;
        if (remaining>0) { smartTimer=setTimeout(()=>speakCurrent(),remaining); return; }
      }
    }
    spokenWord = word;
    speechQueue.push({wordIndex:index,text,unit:'word',start:index,end:index+1});
    renderSpeechStatus();
    playQueuedSpeech();
  }
  function speechEnded(id) {
    if (id!==speechId || !activeTask) return;
    const task=activeTask;
    activeTask=undefined;
    requestedRange=playingRange=undefined; markSpeech();
    if (task.unit==='sentence') completedSentences.add(task.sentenceId);
    if (!armed || !speechEnabled) return;
    if (task.unit==='word') { playQueuedSpeech(); speakCurrent(); return; }
    hybridTimer=setTimeout(()=>{
      hybridTimer=undefined;
      if (id!==speechId || !armed || !speechEnabled) return;
      playQueuedSpeech();
      speakCurrent();
    },160);
  }
  const displayMode = document.getElementById('display-mode');
  const statusbarWords = document.getElementById('statusbar-words');
  const inlineWords = document.getElementById('inline-words');
  const dockFont = document.getElementById('dock-font');
  const dockLines = document.getElementById('dock-lines');
  const dockStyle = document.getElementById('dock-style');
  const dockWidth = document.getElementById('dock-width');
  const dockPosition = document.getElementById('dock-position');
  const hoverOnly = document.getElementById('hover-only');
  const hideOnBlur = document.getElementById('hide-on-blur');
  const showProgress = document.getElementById('show-progress');
  const showDockCaret = document.getElementById('show-dock-caret');
  const screenCentered = document.getElementById('screen-centered');
  let screenAnchor;
  let pointerSample;
  let screenScale = 1;
  function positionReadingStrip() {
    if (!screenCentered.checked || displayMode.value !== 'dock' || dockPosition.value !== 'center' || !screenAnchor) {
      document.body.style.removeProperty('--dock-center');
      return;
    }
    const screenMiddle=(window.screen.availLeft || 0)+window.screen.width/2;
    const center=(screenMiddle-screenAnchor.origin-(window.screenX-screenAnchor.windowX))/screenScale;
    const half=promptPanel.getBoundingClientRect().width/2;
    document.body.style.setProperty('--dock-center',Math.max(half+8,Math.min(innerWidth-half-8,center))+'px');
  }
  // Pointer screen/client coordinates locate the cross-origin Webview without accessing VS Code's DOM.
  window.addEventListener('mousemove',event=>{
    if (!screenCentered.checked) return;
    if (pointerSample && pointerSample.windowX===window.screenX && Math.abs(event.clientX-pointerSample.clientX)>20) {
      const scale=(event.screenX-pointerSample.screenX)/(event.clientX-pointerSample.clientX);
      if (scale>=0.5 && scale<=3) screenScale=scale;
    }
    if (!pointerSample || pointerSample.windowX!==window.screenX || Math.abs(event.clientX-pointerSample.clientX)>20) {
      pointerSample={clientX:event.clientX,screenX:event.screenX,windowX:window.screenX};
    }
    screenAnchor={origin:event.screenX-event.clientX*screenScale,windowX:window.screenX};
    positionReadingStrip();
  });
  window.addEventListener('resize',()=>{pointerSample=undefined;positionReadingStrip();});
  setInterval(positionReadingStrip,300);
  const speechToggle = document.getElementById('speech-enabled');
  const speechModeControl = document.getElementById('speech-mode');
  const smartSpeechControl = document.getElementById('smart-speech');
  const volumeControl = document.getElementById('speech-volume');
  function setPreferences(data) {
    displayMode.value = ['statusbar','comment','reading','inline','dock'].includes(data.displayMode) ? data.displayMode : 'dock';
    document.body.dataset.display = displayMode.value;
    document.body.classList.toggle('reading-strip',displayMode.value==='dock');
    dockPosition.value = ['full','center','right'].includes(data.dockPosition) ? data.dockPosition : 'full';
    document.body.dataset.dockPosition = dockPosition.value;
    showProgress.checked = data.showProgress ?? (data.dockStyle==='standard' || displayMode.value==='statusbar');
    screenCentered.checked = data.screenCentered === true;
    document.body.classList.toggle('show-progress',showProgress.checked);
    showDockCaret.checked = data.showDockCaret !== false;
    document.body.classList.toggle('hide-dock-caret',!showDockCaret.checked);
    document.getElementById('show-progress-label').hidden = !['dock','statusbar'].includes(displayMode.value);
    document.getElementById('screen-centered-label').hidden = displayMode.value!=='dock' || dockPosition.value!=='center';
    dockWidth.value = String(Number.isInteger(data.dockWidth) && data.dockWidth>=240 && data.dockWidth<=960 ? data.dockWidth : 480);
    document.body.style.setProperty('--dock-width',dockWidth.value+'px');
    document.getElementById('dock-width-label').hidden = false;
    dockFont.value = String(Number.isInteger(data.dockFont) && data.dockFont >=12 && data.dockFont<=24 ? data.dockFont : 13);
    dockLines.checked = data.dockLines === 2;
    hoverOnly.checked = data.hoverOnly === true;
    hideOnBlur.checked = data.hideOnBlur === true;
    document.body.classList.toggle('hover-only',hoverOnly.checked);
    document.body.classList.toggle('hide-on-blur',hideOnBlur.checked);
    dockStyle.value = ['compact','standard'].includes(data.dockStyle) ? data.dockStyle : 'compact';
    document.body.dataset.dockStyle = dockStyle.value;
    document.body.style.setProperty('--dock-font',dockFont.value+'px');
    document.body.style.setProperty('--dock-lines',dockLines.checked ? '2' : '1');
    document.getElementById('dock-options').hidden = displayMode.value !== 'dock';
    document.getElementById('reading-options').hidden = ['inline','statusbar'].includes(displayMode.value);
    statusbarWords.value = String([4,8,12,16].includes(data.statusbarWords) ? data.statusbarWords : 8);
    document.getElementById('statusbar-words-label').hidden = displayMode.value !== 'statusbar';
    inlineWords.value = String([2,4,8,12,16].includes(data.inlineWords) ? data.inlineWords : 2);
    document.getElementById('inline-words-label').hidden = displayMode.value !== 'inline';
    const wasSpeechEnabled = speechEnabled;
    const nextSpeechMode=['sentence','hybrid'].includes(data.speechMode)?data.speechMode:'word';
    if(nextSpeechMode!==speechMode) { stopSpeech(); spokenWord=undefined; spokenSentenceStart=-1; activeSentence=undefined; replayPending=false; }
    speechMode=speechModeControl.value=nextSpeechMode;
    smartSpeech=smartSpeechControl.checked=data.smartSpeech===true;
    if (!smartSpeech) { clearTimeout(smartTimer); smartTimer=undefined; }
    speechVolume=Number.isFinite(data.speechVolume) ? Math.max(0,Math.min(300,data.speechVolume)) : 100;
    volumeControl.value=String(speechVolume);
    document.getElementById('speech-volume-value').textContent=speechVolume+'%';
    updateVolume();
    document.getElementById('speech-replay').hidden=speechMode==='word';
    speechEnabled = speechToggle.checked = data.speechEnabled !== false;
    if (!speechEnabled) { stopSpeech(); replayPending=false; }
    else if (!wasSpeechEnabled) { spokenWord = undefined; spokenSentenceStart=-1; speakCurrent(); }
    if (promptState) showWords(promptState);
    buttons();
    positionReadingStrip();
    renderSpeechStatus();
  }
  volumeControl.addEventListener('input',()=>{
    speechVolume=Number(volumeControl.value); updateVolume();
    document.getElementById('speech-volume-value').textContent=speechVolume+'%';
  });
  for (const control of [displayMode,speechToggle,speechModeControl,smartSpeechControl,volumeControl,statusbarWords,inlineWords,dockFont,dockLines,dockStyle,dockWidth,dockPosition,hoverOnly,hideOnBlur,showProgress,showDockCaret,screenCentered]) control.addEventListener('change',()=>{
    for (const input of [dockFont,dockWidth]) if (!input.checkValidity()) { input.reportValidity(); return; }
    const data={displayMode:displayMode.value,speechEnabled:speechToggle.checked,statusbarWords:Number(statusbarWords.value),inlineWords:Number(inlineWords.value),dockFont:Number(dockFont.value),dockLines:dockLines.checked ? 2 : 1,dockStyle:dockStyle.value,dockWidth:Number(dockWidth.value),dockPosition:dockPosition.value,hoverOnly:hoverOnly.checked,hideOnBlur:hideOnBlur.checked};
    data.showProgress=showProgress.checked; data.screenCentered=screenCentered.checked;
    data.showDockCaret=showDockCaret.checked;
    data.speechMode=speechModeControl.disabled ? speechMode : speechModeControl.value;
    data.smartSpeech=smartSpeechControl.checked;
    data.speechVolume=Number(volumeControl.value);
    send('preferences',data); setPreferences(data);
  });

  function resetWords() {
    speechPreparation={}; speechFailure='';
    stopSpeech(); spokenWord = undefined;
    completedSentences.clear();
    spokenSentenceStart=-1; activeSentence=undefined; replayPending=false;
    wordCache.clear(); wordHistory.clear(); pageKey = ''; promptState = undefined;
    wordList.replaceChildren();
    document.getElementById('inline-hint').replaceChildren();
    document.getElementById('input-echo').textContent = '';
    document.getElementById('dock-progress').textContent = '0 / 0';
    document.getElementById('reading-caret').hidden = true;
  }
  function showWords(data) {
    if (!data.target) return;
    const index = Number.isInteger(data.wordIndex) ? data.wordIndex : 0;
    if (wordCache.has(index) && wordCache.get(index) !== data.target) resetWords();
    wordFeedback.updateWordFeedback(wordHistory,data);
    for (const item of data.preview || []) if (Number.isInteger(item.index) && typeof item.text === 'string') wordCache.set(item.index, item.text);
    wordCache.set(index, data.target);
    if (data.next) wordCache.set(index + 1, data.next);
    // Keep enough context for backspacing without growing with a long timed test.
    for (const key of wordCache.keys()) if (key < index - 48 || key > index + 72) wordCache.delete(key);
    const count = wordWindow.clientWidth < 450 ? 12 : 24;
    const dock=displayMode.value==='dock';
    const first=Number(wordList.querySelector('.prompt-word')?.dataset.index);
    let start = dock ? (first<=index && wordCache.has(first) ? first : Math.min(...wordCache.keys())) : Math.floor(index / count) * count;
    // Retire complete old rows in batches, preserving the remaining line breaks.
    if (dock && first<start) {
      const units=[...wordList.querySelectorAll('.word-unit')];
      const anchor=units.find((unit,i)=>Number(unit.firstElementChild.dataset.index)>=index-24 && (i===0 || Math.abs(unit.getBoundingClientRect().top-units[i-1].getBoundingClientRect().top)>1));
      if (anchor) start=Number(anchor.firstElementChild.dataset.index);
    }
    const page = dock ? [...wordCache.keys()].filter(key=>key>=start).sort((a,b)=>a-b) : Array.from({length:count},(_,i)=>start+i).filter(key=>wordCache.has(key));
    const nextKey = `${dock}:${dockLines.checked}:`+page.map(key=>`${key}:${wordCache.get(key)}`).join('|');
    if (nextKey !== pageKey) {
      const previousTop=wordList.querySelector(`[data-index="${index}"]`)?.getBoundingClientRect().top;
      pageKey = nextKey;
      const spans=page.map(key => {
        const span = document.createElement('span');
        span.className = 'prompt-word'; span.dataset.index = String(key);
        span.append(...Array.from(wordCache.get(key)).map(char => {
          const letter = document.createElement('span'); letter.textContent = char; return letter;
        }));
        return span;
      });
      if (dock) {
        const units=[];
        let opening=false;
        for (const span of spans) {
          const text=span.textContent;
          const close=/^[\p{P}\p{S}]+$/u.test(text) && !/^["'([{<]+$/.test(text);
          let unit=units.at(-1);
          if (!unit || !close && !opening) {
            unit=document.createElement('span'); unit.className='word-unit'; units.push(unit);
          }
          unit.append(span);
          opening=/^["'([{<]+$/.test(text);
        }
        wordList.replaceChildren(...units);
      } else wordList.replaceChildren(...spans);
      if (!dock) wordWindow.scrollTop = 0;
      else if (previousTop!==undefined) wordWindow.scrollTop+=wordList.querySelector(`[data-index="${index}"]`).getBoundingClientRect().top-previousTop;
    }
    // Only split a group that would otherwise occupy one row; narrow strips wrap naturally.
    wordList.querySelector('br')?.remove();
    if (!dock && dockLines.checked && page.length>1 && Math.abs(wordList.firstElementChild.getBoundingClientRect().top-wordList.lastElementChild.getBoundingClientRect().top)<1) {
      wordList.insertBefore(document.createElement('br'),wordList.children[Math.ceil(page.length/2)]);
    }
    const typed = data.typed || '';
    for (const span of wordList.querySelectorAll('.prompt-word')) {
      if (!span.classList.contains('prompt-word')) continue;
      const key = Number(span.dataset.index);
      span.className = 'prompt-word' + (key < index ? ' done' : key === index ? ' current' : '');
      const feedback=wordHistory.get(key);
      span.classList.toggle('word-error',Boolean(feedback?.errors.length || feedback?.extra));
      span.classList.toggle('extra-error',Boolean(feedback?.extra));
      // All words retain the same character nodes, so highlighting cannot change glyph spacing.
      Array.from(span.children).forEach((letter, i) => {
        letter.className = feedback?.errors.includes(i) ? 'incorrect' : key !== index ? feedback?.complete ? 'correct' : '' : i < typed.length ? 'correct' : i === typed.length ? 'next-char' : '';
      });
      if (key !== index) { span.removeAttribute('aria-current'); continue; }
      span.setAttribute('aria-current','true');
      const rect=span.getBoundingClientRect(); const viewport=wordWindow.getBoundingClientRect();
      if (rect.bottom > viewport.bottom+1 || rect.top < viewport.top-1) wordWindow.scrollTop += rect.top - viewport.top;
    }
    const echo=document.getElementById('input-echo'); echo.textContent=typed || '…'; echo.classList.toggle('wrong',!data.target.startsWith(typed));
    const progress=document.getElementById('dock-progress');
    progress.textContent=`${typed.length} / ${data.target.length}`;
    progress.classList.toggle('wrong',!data.target.startsWith(typed));
    progress.title=`已输入：${typed || '（空）'}`;
    const readingCaret=document.getElementById('reading-caret');
    const current=wordList.querySelector('.current');
    readingCaret.hidden=displayMode.value!=='dock' || !current || Boolean(data.finished);
    if (!readingCaret.hidden) {
      const letter=current.children[Math.min(typed.length,current.children.length-1)];
      const bounds=letter.getBoundingClientRect(); const windowBounds=wordWindow.getBoundingClientRect();
      if (current.getBoundingClientRect().width<=wordWindow.clientWidth) wordWindow.scrollLeft=0;
      else if (bounds.right>windowBounds.right || bounds.left<windowBounds.left) wordWindow.scrollLeft+=bounds.left-windowBounds.left-wordWindow.clientWidth/2;
      const rect=letter.getBoundingClientRect(); const viewport=wordWindow.getBoundingClientRect();
      const x=(typed.length>=data.target.length ? rect.right : rect.left)-viewport.left+wordWindow.scrollLeft;
      const y=rect.top-viewport.top+wordWindow.scrollTop;
      readingCaret.style.transition=readingCaret.dataset.row===String(y) ? '' : 'none';
      readingCaret.dataset.row=String(y);
      readingCaret.style.height=rect.height+'px';
      readingCaret.style.transform=`translate(${x}px,${y}px)`;
    }
    document.getElementById('word-position').textContent=`第 ${index+1} 词 · 本组 ${page.length} 词`;
    document.getElementById('input-status').textContent=typed===data.target ? '✓ Space 换词' : data.target.startsWith(typed) ? 'Space 换词 · Backspace 改错' : `目标 ${data.target} · Backspace 改错`;
    promptPanel.title = `第 ${index+1} 词 · ${document.getElementById('input-status').textContent}`;
    const inlineHint=document.getElementById('inline-hint');
    const inlineCount=Number(inlineWords.value);
    const inlineStart=Math.floor(index/inlineCount)*inlineCount;
    const inlineGroup=Array.from({length:inlineCount},(_,i)=>inlineStart+i).filter(key=>wordCache.has(key));
    inlineHint.replaceChildren(document.createTextNode('// '),...inlineGroup.map(key=>{
      const word=document.createElement('span');
      word.dataset.index=String(key);
      const feedback=wordHistory.get(key);
      word.className='inline-word'+(key===index?' current':'')+(feedback?.errors.length || feedback?.extra?' word-error':'')+(feedback?.extra?' extra-error':'');
      word.append(...Array.from(wordCache.get(key),(char,i)=>{
        const letter=document.createElement('span'); letter.textContent=char;
        letter.className=feedback?.errors.includes(i)?'incorrect':key===index && i===typed.length?'next-char':feedback?.complete || key===index && i<typed.length?'correct':'';
        return letter;
      }));
      return word;
    }));
    inlineHint.title = `目标：${data.target}\n已输入：${typed || '（空）'}\n\n${inlineGroup.map(key=>wordCache.get(key)).join(' ')}`;
    positionInlineHint();
    if (promptState?.wordIndex!==data.wordIndex || promptState?.typed!==data.typed) lastInputAt=Date.now();
    promptState=data;
    smartSpeechControl.disabled=effectiveSpeechMode()!=='hybrid';
    markSpeech();
    buttons();
    const replay=replayPending && armed;
    if(replay) replayPending=false;
    speakCurrent(replay);
  }
  new ResizeObserver(()=>{if(promptState)showWords(promptState)}).observe(wordWindow);
  function positionInlineHint() {
    const hint=document.getElementById('inline-hint');
    if (document.body.dataset.display !== 'inline') return;
    const rect=caret.getBoundingClientRect(); const viewport=editor.getBoundingClientRect();
    const left=viewport.right-rect.right < 180 ? viewport.left+65 : rect.right+16;
    hint.style.left=left+'px';
    hint.style.top=(viewport.right-rect.right < 180 ? rect.bottom+2 : rect.top)+'px';
    hint.style.maxWidth=Math.max(0,viewport.right-left-20)+'px';
    hint.style.visibility=rect.bottom>viewport.bottom-28 || rect.top<viewport.top ? 'hidden' : 'visible';
  }
  editor.addEventListener('scroll',positionInlineHint);
  window.addEventListener('resize',positionInlineHint);
  function revealCode(force) {
    const rect=caret.getBoundingClientRect(); const viewport=editor.getBoundingClientRect();
    if (force || rect.bottom > viewport.bottom-40 || rect.top < viewport.top+12) editor.scrollTop += rect.top - viewport.top - viewport.height*.45;
    if (force || rect.right > viewport.right-24 || rect.left < viewport.left+65) editor.scrollLeft=Math.max(0,editor.scrollLeft+rect.left-viewport.left-100);
    positionInlineHint();
  }
  const report = document.getElementById('report');
  const settingsPanel = document.getElementById('settings-panel');
  const nextTest = document.getElementById('next-test');
  const repeatTest = document.getElementById('repeat-test');
  function buttons() {
    for (const button of [nextTest,repeatTest,document.getElementById('report-next'),document.getElementById('report-repeat')]) button.disabled = !finished || busy;
    const forced=promptState?.testMode==='words';
    speechModeControl.disabled=forced;
    speechModeControl.value=forced ? 'word' : speechMode;
    speechModeControl.title=forced ? '官网 words 模式固定逐词朗读；其他模式使用已保存的选择' : '';
    document.getElementById('speech-replay').hidden=effectiveSpeechMode()==='word';
    document.getElementById('speech-replay').disabled = !speechEnabled || busy || finished || !promptState?.sentence || forced;
  }

  function pause(text) {
    armed = false;
    stopSpeech(); spokenWord = undefined;
    replayPending=false;
    held.clear();
    resume.textContent = '已暂停';
    resume.title = text;
    resume.setAttribute('aria-label',text);
    document.body.classList.remove('armed');
    document.getElementById('suggestions').hidden = true;
    renderSpeechStatus();
  }
  function arm() {
    if (busy || finished) return;
    editor.focus();
    send('arm');
  }
  resume.addEventListener('click', () => finished ? send('result') : arm());
  document.getElementById('tts-retry').addEventListener('mousedown',event=>event.preventDefault());
  document.getElementById('tts-retry').addEventListener('click',()=>send('speech-retry'));
  editor.addEventListener('click', () => { if (!armed && !finished) arm(); });
  promptPanel.addEventListener('mousedown', event => { event.preventDefault(); editor.focus({preventScroll:true}); });
  promptPanel.addEventListener('click', () => { if (!armed && !finished) arm(); });
  document.getElementById('open').addEventListener('click', () => send('browser'));
  document.getElementById('result').addEventListener('click', () => send('result'));
  document.getElementById('relay-files').addEventListener('click', () => send('relay-files'));
  document.getElementById('relay-clear').addEventListener('click', () => send('relay-clear'));
  const toolsMenu = document.getElementById('tools-menu');
  toolsMenu.addEventListener('click', event => { if (event.target.closest('button')) toolsMenu.open = false; });
  document.addEventListener('mousedown', event => { if (!toolsMenu.contains(event.target)) toolsMenu.open = false; });
  nextTest.addEventListener('click', () => { if (!busy && finished) send('next-test'); });
  repeatTest.addEventListener('click', () => { if (!busy && finished) send('repeat-test'); });
  document.getElementById('report-next').addEventListener('click', () => { if (!busy && finished) send('next-test'); });
  document.getElementById('report-repeat').addEventListener('click', () => { if (!busy && finished) send('repeat-test'); });
  document.getElementById('settings-toggle').addEventListener('click', () => {
    document.getElementById('speech-panel').hidden = true;
    settingsPanel.hidden = !settingsPanel.hidden;
  });
  document.getElementById('speech-toggle').addEventListener('click',()=>{
    settingsPanel.hidden=true;
    const panel=document.getElementById('speech-panel'); panel.hidden=!panel.hidden;
  });
  document.getElementById('speech-configure').addEventListener('click',()=>send('speech-settings'));
  document.getElementById('speech-references').addEventListener('click',()=>send('reference-settings'));
  document.getElementById('speech-replay').addEventListener('mousedown',event=>event.preventDefault());
  document.getElementById('speech-replay').addEventListener('click',()=>{
    if (!speechEnabled || busy || finished || !promptState?.sentence || effectiveSpeechMode()==='word') return;
    if (armed) speakCurrent(true);
    else { replayPending=true; arm(); }
  });
  const mode = document.getElementById('mode');
  const amount = document.getElementById('amount');
  function amounts() {
    const values = mode.value === 'time' ? [15,30,60,120] : mode.value === 'words' ? [10,25,50,100] : ['all','short','medium','long','thicc'];
    amount.replaceChildren(...values.map(value => new Option(String(value), String(value))));
  }
  amounts(); mode.addEventListener('change', amounts);
  document.getElementById('settings-form').addEventListener('submit', event => {
    event.preventDefault();
    if (busy) return;
    pause('正在应用测试设置…'); send('pause');
    send('settings', { settings: { mode: mode.value, amount: mode.value === 'quote' ? amount.value : Number(amount.value),
      language: document.getElementById('language').value, punctuation: document.getElementById('punctuation').checked, numbers: document.getElementById('numbers').checked } });
  });
  document.getElementById('report-close').addEventListener('click', () => { report.hidden = true; document.body.classList.remove('has-report'); });
  document.getElementById('export').addEventListener('click', () => send('export'));
  document.getElementById('print').addEventListener('click', () => send('print'));

  for (const type of ['keydown', 'keyup']) editor.addEventListener(type, event => {
    if (!event.isTrusted) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (type === 'keydown') { pause('练习已结束。'); send('stop'); }
      return;
    }
    if (finished && event.key === 'Enter' && !busy) {
      event.preventDefault();
      if (type === 'keydown' && !event.repeat) send('next-test');
      return;
    }
    if (!armed || finished || busy) return;
    if (event.ctrlKey || event.altKey || event.metaKey || event.key === 'Tab') {
      pause('已暂停；点击继续。官网计时不会暂停。');
      send('pause');
      return;
    }
    event.preventDefault();
    if (event.isComposing || event.key === 'Process' || event.key === 'Dead' || event.keyCode === 229) {
      pause('请切换到英文输入法，再点击继续。');
      send('pause');
      return;
    }
    if (type === 'keydown') held.add(event.code);
    else if (!held.delete(event.code)) return;
    send('key', { sentAt: Date.now(), event: {
      type, key: event.key, code: event.code, keyCode: event.keyCode,
      repeat: event.repeat,
      modifiers: (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0),
    }});
  });

  function loseFocus() {
    if (!armed) return;
    pause('已暂停；点击继续。官网计时不会暂停。');
    send('pause');
  }
  window.addEventListener('blur', () => { document.body.classList.add('view-inactive'); loseFocus(); });
  window.addEventListener('focus', () => document.body.classList.remove('view-inactive'));
  editor.addEventListener('blur', loseFocus);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && armed) { pause('已暂停；点击继续。'); send('pause'); }
  });
  window.addEventListener('message', ({ data }) => {
    if (data.type === 'speech-preparation') {
      if (data.epoch!==speechEpoch) return;
      speechPreparation=data;
      renderSpeechStatus();
    } else if (data.type === 'view-active') {
      document.body.classList.toggle('view-inactive',!data.active);
      if (!data.active) loseFocus();
    } else if (data.type === 'preferences') {
      setPreferences(data);
    } else if (data.type === 'speech' && data.id === speechId && data.id!==playedSpeechId && armed && speechEnabled) {
      playedSpeechId=data.id;
      audioReceived=true; speechFailure=''; renderSpeechStatus();
      document.getElementById('speech-status').textContent = '';
      const failed = text => { if (data.id === speechId) { speechFailure=text; document.getElementById('speech-status').textContent=text; resume.title=text; speechEnded(data.id); renderSpeechStatus(); } };
      if (data.native) {
        if (!window.speechSynthesis) { failed('当前环境没有系统语音，请配置 TTS 接口。'); return; }
        const utterance = new SpeechSynthesisUtterance(data.text);
        nativeUtterance=utterance; updateVolume();
        utterance.lang = 'en-US';
        utterance.onend=()=>speechEnded(data.id);
        utterance.onstart=()=>speechStarted(data.id);
        utterance.rate = data.rate || 1;
        if (data.voice) utterance.voice=window.speechSynthesis.getVoices().find(voice=>voice.name===data.voice) || null;
        utterance.onerror = event => { if (!['canceled','interrupted'].includes(event.error)) failed(`系统朗读不可用：${event.error}，可配置 TTS 接口。`); };
        window.speechSynthesis.speak(utterance);
      } else if (/^audio\/[a-z0-9.+-]+$/i.test(data.mime || '')) {
        audio = new Audio(`data:${data.mime};base64,${data.audio}`);
        if (!audioContext) {
          audioContext=new AudioContext(); audioGain=audioContext.createGain(); audioGain.connect(audioContext.destination);
        }
        audioSource=audioContext.createMediaElementSource(audio); audioSource.connect(audioGain); updateVolume();
        void audioContext.resume().catch(()=>failed('无法启用音频播放，请点击练习区重试。'));
        audio.onended=()=>speechEnded(data.id);
        audio.onplaying=()=>speechStarted(data.id);
        audio.onwaiting=()=>{ if (data.id===speechId) { playingRange=undefined; markSpeech(); } };
        audio.onerror=()=>failed('音频无法播放，请检查 TTS 返回格式。');
        audio.play().catch(()=>failed('音频无法播放，请检查 TTS 返回格式。'));
      }
    } else if (data.type === 'speech-started') {
      speechStarted(data.id);
    } else if (data.type === 'speech-ended') {
      speechEnded(data.id);
    } else if (data.type === 'speech-error' && data.id === speechId) {
      speechFailure=data.text;
      document.getElementById('speech-status').textContent=data.text;
      resume.title=`朗读失败：${data.text}`;
      speechEnded(data.id);
      renderSpeechStatus();
    } else if (data.type === 'code') {
      if (Number.isInteger(data.tabSize) && data.tabSize >= 1 && data.tabSize <= 32) document.body.style.setProperty('--code-tab',String(data.tabSize));
      if (code.dataset.html!==data.html) { code.innerHTML = data.html; code.dataset.html=data.html; }
      const gutter=document.getElementById('gutter');
      if (gutter.dataset.lines!==String(data.lines)) {
        gutter.textContent = Array.from({ length: data.lines }, (_, i) => i + 1).join('\n');
        gutter.dataset.lines=String(data.lines);
      }
      if (armed || data.reveal) revealCode(Boolean(data.reveal));
      document.getElementById('note').textContent = `Ln ${data.lines}, Col ${(code.textContent.split('\n').at(-1) || '').length + 1}`;
      document.getElementById('note').title = data.complete ? '当前文件已显示完整；继续输入可接力下一个文件。Esc 返回原文件。' : 'Esc 返回原文件';
      if (data.fileName) document.getElementById('file-name').textContent = data.fileName;
      if (data.language) document.getElementById('file-language').textContent = ` › ${data.language}`;
      if (data.relayCount) document.getElementById('relay-files').textContent = `选择接力文件…（当前 ${data.relayCount} 个）`;
    } else if (data.type === 'state') {
      if(data.speechEpoch!==undefined && data.speechEpoch!==speechEpoch) {
        resetWords(); speechEpoch=data.speechEpoch;
      }
      if (data.backgroundSuspended) {
        pause(data.reason);
        return;
      }
      const wasFinished = finished;
      finished = Boolean(data.finished);
      if (finished) document.getElementById('reading-caret').hidden=true;
      buttons();
      showWords(data);
      renderSpeechStatus();
      if (finished && !wasFinished && !reportReceived) pause('测试结束，正在自动读取成绩…');
    } else if (data.type === 'armed') {
      armed = true;
      finished = false;
      resume.textContent = '运行中';
      resume.title = '已连接官网；Esc 返回原文件';
      resume.setAttribute('aria-label',resume.title);
      document.body.classList.add('armed');
      editor.focus();
      // The host follows armed with fresh state; do not speak using the paused snapshot.
    } else if (data.type === 'halt') {
      pause(data.text);
    } else if (data.type === 'report') {
      document.body.classList.add('has-result');
      reportReceived = true;
      finished = true;
      buttons();
      pause('测试已完成 · Enter / Next test 开始下一场');
      const m = data.metrics;
      resume.textContent = `wpm ${m.wpm} · acc ${m.accuracy} · ${Number.isFinite(data.xp) ? `XP +${data.xp}` : 'XP 待确认'} · ${Number.isInteger(data.level) ? `Lv ${data.level}` : 'Lv --'}`;
      resume.title = `${data.accountStatus} · 点击查看详情，Enter 开始下一场`;
      resume.setAttribute('aria-label',resume.title);
      document.getElementById('metrics').textContent = `wpm ${m.wpm}    acc ${m.accuracy}    raw ${m.raw}    consistency ${m.consistency}\ncharacters ${m.characters}    time ${m.time}\n${m.testType}${m.source ? '  ·  '+m.source : ''}`;
      document.getElementById('account-status').textContent = data.accountStatus;
      document.getElementById('local-status').textContent = data.localStatus;
      if (!report.hidden) document.body.classList.add('has-report');
    } else if (data.type === 'show-report') {
      report.hidden = false;
      document.body.classList.add('has-report');
    } else if (data.type === 'round-reset') {
      document.body.classList.remove('has-result');
      resetWords();
      finished = reportReceived = false;
      report.hidden = settingsPanel.hidden = true;
      document.body.classList.remove('has-report');
      buttons();
    } else if (data.type === 'busy') {
      busy = data.value !== false;
      buttons();
      if (busy) pause(data.text);
      document.querySelector('#settings-form button[type=submit]').disabled = busy;
    } else if (data.type === 'action-error') {
      pause(data.text);
    } else if (data.type === 'suggestions') {
      const popup = document.getElementById('suggestions');
      popup.replaceChildren(...data.items.map((item, i) => {
        const row = document.createElement('div');
        row.className = 'suggestion-row' + (i === 0 ? ' selected' : '');
        const icon = document.createElement('span'); icon.className = 'suggestion-icon'; icon.textContent = item.origin === 'VS Code' ? 'ƒ' : 'abc';
        const label = document.createElement('span'); label.textContent = item.label;
        const detail = document.createElement('small'); detail.textContent = item.detail;
        row.append(icon,label,detail); return row;
      }));
      popup.hidden = !data.items.length || !armed;
      const rect = caret.getBoundingClientRect();
      popup.style.left = Math.max(8,Math.min(rect.left,innerWidth-330))+'px';
      const hintBottom=document.body.dataset.display==='inline' ? document.getElementById('inline-hint').getBoundingClientRect().bottom : rect.bottom;
      const editorBox=editor.getBoundingClientRect();
      popup.style.top = Math.max(editorBox.top,Math.min(Math.max(rect.bottom,hintBottom)+3,editorBox.bottom-popup.offsetHeight-4))+'px';
    }
  });
  send('ready');
})();
