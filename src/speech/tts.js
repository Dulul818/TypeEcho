const { spawn } = require('node:child_process');

// Keep the Windows voice engine alive across words, avoiding per-word process startup.
function createSystemSpeaker(onError, onEnded = () => {}, onStarted = () => {}) {
  let child;
  function stop() { if (child?.stdin.writable) child.stdin.write('\n'); }
  function speak(text, options = {}) {
    if (!child) {
      const script = `$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Speech
Add-Type -ReferencedAssemblies System.Speech -TypeDefinition @'
using System;
using System.Speech.Synthesis;
public static class BridgeSpeech {
  public static void Speak(SpeechSynthesizer speaker, string text, int id) {
    var prompt = new Prompt(text);
    EventHandler<SpeakStartedEventArgs> started = (sender, e) => {
      if (e.Prompt == prompt) Console.WriteLine("start:" + id);
    };
    EventHandler<SpeakCompletedEventArgs> completed = null;
    completed = (sender, e) => {
      if (e.Prompt != prompt) return;
      speaker.SpeakCompleted -= completed;
      speaker.SpeakStarted -= started;
      if (!e.Cancelled && e.Error == null) Console.WriteLine(id);
    };
    speaker.SpeakCompleted += completed;
    speaker.SpeakStarted += started;
    speaker.SpeakAsync(prompt);
  }
}
'@
$speaker=New-Object System.Speech.Synthesis.SpeechSynthesizer
$speaker.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::NotSet,[System.Speech.Synthesis.VoiceAge]::NotSet,0,[System.Globalization.CultureInfo]::GetCultureInfo('en-US'))
$defaultVoice=$speaker.Voice.Name
while ($null -ne ($line=[Console]::ReadLine())) {
  $speaker.SpeakAsyncCancelAll()
  if ($line.Length -gt 0) {
    $request=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line)) | ConvertFrom-Json
    if ($request.voice) { $speaker.SelectVoice($request.voice) } else { $speaker.SelectVoice($defaultVoice) }
    $speaker.Rate=[Math]::Max(-10,[Math]::Min(10,[int][Math]::Round(5*[Math]::Log($request.rate,2))))
    $speaker.Volume=$request.volume
    [BridgeSpeech]::Speak($speaker,$request.text,$request.id)
  }
}
$speaker.Dispose()`;
      const process = child = spawn('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')], {windowsHide:true,stdio:['pipe','pipe','pipe']});
      let output='';
      process.stdout.on('data',chunk=>{
        output+=chunk.toString();
        const lines=output.split(/\r?\n/); output=lines.pop();
        for (const line of lines) {
          if (/^\d+$/.test(line)) onEnded(Number(line));
          else if (/^start:\d+$/.test(line)) onStarted(Number(line.slice(6)));
        }
      });
      let errorText = '';
      process.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(0, 1000); });
      process.on('error', () => onError('无法启动 Windows 系统朗读，请配置 TTS 接口。'));
      process.stdin.on('error', () => {});
      process.on('exit', code => { if (child === process) { child = undefined; if (code) onError(errorText || '系统朗读退出。'); } });
    }
    child.stdin.write(Buffer.from(JSON.stringify({text,voice:options.voice || '',rate:options.rate || 1,id:options.id || 0,volume:options.volume ?? 100}),'utf8').toString('base64')+'\n');
  }
  return {speak,stop,dispose() { const process=child; child=undefined; process?.kill(); }};
}

// Custom endpoint contract: POST {text, language, voice, rate}, return audio bytes (no disk cache).
async function requestSpeech(endpoint, text, signal, options = {}) {
  const url = new URL(endpoint);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('TTS 地址须为 HTTP(S)，不支持地址内嵌密码。');
  if (typeof text !== 'string' || !/^[\x20-\x7e]{1,1200}$/.test(text)) throw new Error('朗读文本须为 1–1200 个英文字符。');
  const gptSovits=options.provider==='gpt-sovits';
  let payload={text,language:'en-US',voice:options.voice,rate:options.rate};
  if (gptSovits) {
    if (!options.referenceAudio?.trim() || !options.referenceText?.trim()) throw new Error('请先设置 GPT-SoVITS 参考音频路径和对应文本。');
    payload={text,text_lang:'en',ref_audio_path:options.referenceAudio.trim(),prompt_text:options.referenceText.trim(),
      prompt_lang:options.referenceLanguage || 'en',speed_factor:options.rate || 1,
      text_split_method:'cut0',batch_size:1,parallel_infer:true,seed:1234,
      // The API pads every clip; word playback waits for this silence before advancing.
      fragment_interval:/\s/.test(text.trim()) ? 0.3 : 0.03,
      top_k:15,top_p:1,temperature:1,repetition_penalty:1.35,media_type:'wav',streaming_mode:false};
  }
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]), redirect: 'error' });
  if (!response.ok) {
    if (gptSovits) {
      const detail=await response.json().catch(()=>({}));
      throw new Error(`GPT-SoVITS HTTP ${response.status}: ${[detail.message,detail.Exception].filter(value=>typeof value==='string').join(' · ').slice(0,300) || '语音请求失败'}`);
    }
    await response.body?.cancel(); throw new Error(`TTS HTTP ${response.status}`);
  }
  const mime = (response.headers.get('content-type') || '').split(';')[0];
  if (!/^audio\/[a-z0-9.+-]+$/i.test(mime)) { await response.body?.cancel(); throw new Error('TTS 接口须返回 audio/* 音频。'); }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 12 * 1024 * 1024) throw new Error('TTS 音频超过 12MB。');
    chunks.push(chunk);
  }
  if (!size) throw new Error('TTS 返回空音频。');
  return { mime, audio: Buffer.concat(chunks).toString('base64') };
}

// One lookahead and at most one foreground request. Cached foreground audio can
// return while the server finishes background GPU work, without cancellation storms.
// Round sentences are retained; ordinary word audio stays within 32 MiB / 128 clips.
function createSpeechCache(synthesize = requestSpeech, onProgress = () => {}) {
  const entries = new Map();
  let queue = [], running, foreground;
  let pinned=new Set(), tracked=new Set(), progressTimer;
  const keyFor = (endpoint, text, options) => JSON.stringify([endpoint, text, options.voice, options.rate,
    options.provider,options.referenceAudio,options.referenceText,options.referenceLanguage]);
  function report() {
    progressTimer ??= setImmediate(()=>{
      progressTimer=undefined;
      let ready=0,failed=0,error='';
      for (const key of tracked) {
        const entry=entries.get(key);
        if (entry?.bytes) ready++;
        if (entry?.failedAt) { failed++; error=entry.error; }
      }
      onProgress({ready,total:tracked.size,failed,error,unit:pinned.size ? 'sentence' : 'word'});
    });
  }
  function remove(key, entry) {
    if (entries.get(key) !== entry) return;
    entries.delete(key);
    entry.invalidated = true;
    // Closing HTTP does not stop GPU inference. Keep its slot until it finishes.
    if (running !== entry && foreground !== entry) entry.controller.abort();
    entry.reject(new Error('语音预生成已取消'));
  }
  function trimCache() {
    let bytes=0,count=0;
    for (const [key,entry] of entries) if (!pinned.has(key)) { bytes+=entry.bytes || 0; count++; }
    for (const [key,entry] of entries) {
      if (bytes<=32*1024*1024 && count<=128) break;
      if (!pinned.has(key) && (entry.bytes || entry.failedAt)) { bytes-=entry.bytes || 0; count--; remove(key,entry); }
    }
  }
  function pump() {
    // Official GPT-SoVITS serves one shared pipeline; do not stack HTTP inference requests.
    if (!queue.length || foreground || running && (running.options.provider==='gpt-sovits' || running.urgent || !queue[0].urgent)) return;
    const entry = queue.shift();
    if (running) foreground=entry;
    else running=entry;
    Promise.resolve().then(() => {
      if (entry.invalidated) throw new Error('语音预生成已取消');
      entry.controller.signal.throwIfAborted();
      return synthesize(entry.endpoint, entry.text, entry.controller.signal, entry.options);
    }).then(result => {
      if (entry.invalidated || entry.controller.signal.aborted) return;
      entry.bytes = Buffer.byteLength(result.audio, 'base64');
      entry.resolve(result);
      trimCache();
      report();
    }, error => {
      entry.reject(error);
      if (entries.get(entry.key) === entry) {
        entry.failedAt = Date.now();
        entry.error = error.message;
        trimCache();
        report();
      }
    }).finally(() => {
      if (running === entry) running = undefined;
      if (foreground === entry) foreground = undefined;
      pump();
    });
  }
  function obtain(endpoint, text, options, urgent, schedule=true) {
    const key = keyFor(endpoint, text, options);
    let entry = entries.get(key);
    if (entry?.failedAt && (urgent || Date.now() - entry.failedAt > 5000)) { remove(key, entry); entry = undefined; }
    if (!entry) {
      entry = {key, endpoint, text, options, controller:new AbortController()};
      entry.promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
      // Lookahead has no playback consumer yet; foreground still receives failures.
      entry.promise.catch(() => {});
      entries.set(key, entry);
      queue.push(entry);
    } else {
      entries.delete(key); entries.set(key, entry);
    }
    if (urgent) {
      entry.urgent = true;
      if (queue.includes(entry)) {
        queue = [entry, ...queue.filter(item => item !== entry)];
        // The next unscheduled request gets priority; never resubmit active GPU work.
      }
    }
    if (schedule) pump();
    return entry.promise;
  }
  return {
    get(endpoint, text, options, signal) {
      const promise = obtain(endpoint, text, options, true);
      const entry = entries.get(keyFor(endpoint, text, options));
      // Playback cancellation does not discard useful synthesis already in progress.
      if (signal) {
        const cancel = () => { if (entry) entry.urgent = false; };
        if (signal.aborted) cancel();
        else {
          signal.addEventListener('abort', cancel, {once:true});
          promise.then(() => signal.removeEventListener('abort', cancel), () => signal.removeEventListener('abort', cancel));
        }
      }
      return promise;
    },
    prepare(endpoint, texts, options, sentences=[]) {
      pinned=new Set(sentences.map(text=>keyFor(endpoint,text,options)));
      tracked=new Set((sentences.length ? sentences : texts).map(text=>keyFor(endpoint,text,options)));
      const wanted = new Set(texts.map(text => keyFor(endpoint, text, options)));
      for (const entry of queue) if (!entry.urgent && !wanted.has(entry.key)) remove(entry.key, entry);
      queue = queue.filter(entry => !entry.controller.signal.aborted);
      for (const text of texts) obtain(endpoint, text, options, false, false);
      const priority=new Map([...wanted].map((key,index)=>[key,index]));
      queue.sort((a,b)=>Number(Boolean(b.urgent))-Number(Boolean(a.urgent)) || (priority.get(a.key) ?? -1)-(priority.get(b.key) ?? -1));
      trimCache();
      pump(); report();
    },
    retryFailed() {
      for (const [key,entry] of entries) if (entry.failedAt) remove(key,entry);
      report();
    },
    cancelPending() {
      for (const [key,entry] of entries) if (!entry.bytes && !entry.failedAt) remove(key,entry);
      queue=[];
      report();
    },
    clear() {
      for (const [key, entry] of entries) remove(key, entry);
      queue = [];
      pinned.clear(); tracked.clear(); report();
    },
  };
}

module.exports = { requestSpeech, createSystemSpeaker, createSpeechCache };
