const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { requestSpeech } = require('../speech/tts');

async function loadReferences(manifest) {
  if (!manifest) return [];
  const rows = JSON.parse(await fs.readFile(manifest, 'utf8'));
  if (!Array.isArray(rows) || rows.length > 100) throw new Error('参考音频列表须为最多 100 项的 JSON 数组。');
  return rows.map(row => {
    if (typeof row.audio !== 'string' || !row.audio || typeof row.text !== 'string' || !row.text.trim()) throw new Error('每条参考音频都需要路径和实际字幕。');
    return { audio:path.resolve(path.dirname(manifest),row.audio), text:row.text.trim(), language:row.language || 'en',
      name:path.basename(row.audio,path.extname(row.audio)), duration:row.duration_seconds, primary:!!row.primary };
  });
}

function registerReferencePanel(vscode, context) {
  let panel;
  return async function open() {
    if (panel) { panel.reveal(); return; }
    const current = panel = vscode.window.createWebviewPanel('codeType.references','参考音频',vscode.ViewColumn.Beside,
      {enableScripts:true,retainContextWhenHidden:true,localResourceRoots:[vscode.Uri.joinPath(context.extensionUri,'media')]});
    let rows=[], selected='', revision=0, busy=false, closed=false;
    const controller=new AbortController();
    const config=()=>vscode.workspace.getConfiguration('codeType');
    const send=message=>{if(!closed)void current.webview.postMessage(message);};
    const error=err=>send({type:'status',text:err.message || String(err),error:true});
    async function refresh() {
      const saved=context.globalState.get('referenceAudioImports') || [];
      rows=await loadReferences(config().get('ttsReferenceLibrary'));
      rows.push(...saved);
      const atomic=config().get('ttsReference');
      const active=atomic?.audio ? atomic : {audio:config().get('ttsReferenceAudio'),text:config().get('ttsReferenceText'),language:config().get('ttsReferenceLanguage') || 'en'};
      if (active.audio && active.text && !rows.some(row=>row.audio===active.audio && row.text===active.text)) rows.push({...active,name:path.basename(active.audio)});
      rows=rows.filter((row,index)=>rows.findIndex(other=>other.audio===row.audio && other.text===row.text)===index);
      selected=rows.findIndex(row=>row.audio===active.audio && row.text===active.text && row.language===active.language);
      current.webview.options={...current.webview.options,localResourceRoots:[vscode.Uri.joinPath(context.extensionUri,'media'),...rows.map(row=>vscode.Uri.file(path.dirname(row.audio)))]};
      const present=await Promise.all(rows.map(async(row,index)=>{
        const exists=await fs.stat(row.audio).then(stat=>stat.isFile(),()=>false);
        return {...row,id:index,exists,url:exists ? current.webview.asWebviewUri(vscode.Uri.file(row.audio)).toString() : ''};
      }));
      send({type:'references',rows:present,selected,provider:config().get('ttsProvider') || 'custom'});
    }
    current.onDidDispose(()=>{closed=true;controller.abort();panel=undefined;});
    const listener=vscode.workspace.onDidChangeConfiguration?.(event=>{
      if (event.affectsConfiguration('codeType')) { revision++;void refresh().catch(error); }
    });
    current.onDidDispose(()=>listener?.dispose());
    context.subscriptions.push(current);
    current.webview.onDidReceiveMessage(async message=>{
      try {
        if (message.type==='ready') await refresh();
        else if (message.type==='select') {
          const row=rows[message.id];
          if (!row || !Number.isInteger(message.id)) return;
          if (!(await fs.stat(row.audio)).isFile()) throw new Error('参考音频文件不存在。');
          revision++;
          await config().update('ttsReference',{audio:row.audio,text:row.text,language:row.language},vscode.ConfigurationTarget.Global);
          await refresh();send({type:'status',text:'已切换参考音频'});
        } else if (message.type==='import') {
          const files=await vscode.window.showOpenDialog({canSelectMany:false,filters:{'参考音频':['wav','mp3','flac','ogg','m4a']},title:'选择参考录音'});
          if (!files?.length) return;
          const audio=files[0].fsPath;
          const sidecar=await fs.readFile(audio.replace(/\.[^.]+$/,'.txt'),'utf8').catch(()=>'');
          const text=await vscode.window.showInputBox({title:'录音中的实际字幕',value:sidecar.trim(),ignoreFocusOut:true,validateInput:value=>value.trim()?undefined:'请填写与录音一致的字幕'});
          if (!text?.trim()) return;
          const language=await vscode.window.showQuickPick(['en','zh','ja','ko','yue'],{title:'参考录音语言'});
          if (!language) return;
          const saved=context.globalState.get('referenceAudioImports') || [];
          await context.globalState.update('referenceAudioImports',[...saved.filter(row=>row.audio!==audio),{audio,text:text.trim(),language,name:path.basename(audio)}]);
          await refresh();send({type:'status',text:'录音已导入'});
        } else if (message.type==='settings') {
          await vscode.commands.executeCommand('workbench.action.openSettings','@ext:local-prototype.code-type-bridge tts');
        } else if (message.type==='preview' && !busy) {
          const row=rows[selected];
          if (!row) throw new Error('请先选择参考录音。');
          if (config().get('ttsProvider')!=='gpt-sovits') throw new Error('请先将语音接口类型设置为 GPT-SoVITS。');
          busy=true;const generation=revision;
          send({type:'busy',value:true});send({type:'status',text:'等待模型生成试听…'});
          try {
            const clip=await requestSpeech(config().get('ttsEndpoint'),message.text,controller.signal,
              {provider:'gpt-sovits',referenceAudio:row.audio,referenceText:row.text,referenceLanguage:row.language,rate:config().get('ttsRate') || 1});
            if (generation===revision) {send({type:'preview',...clip});send({type:'status',text:'试听已生成'});}
            else send({type:'status',text:'参考音频已改变，请重新生成试听'});
          } finally {busy=false;send({type:'busy',value:false});}
        }
      } catch(err) {error(err);}
    });
    current.webview.html=referenceHtml(current.webview,context.extensionUri,vscode);
  };
}

function referenceHtml(webview,root,vscode) {
  const nonce=crypto.randomBytes(18).toString('base64');
  const media=name=>webview.asWebviewUri(vscode.Uri.joinPath(root,'media',name));
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; media-src ${webview.cspSource} data:;">
  <link rel="stylesheet" href="${media('references.css')}"><title>参考音频</title></head>
  <body><main><header><h1>参考音频</h1><div class="actions"><button id="import">导入录音</button><button id="settings">语音设置</button></div></header>
  <p id="provider"></p><div id="references" role="radiogroup" aria-label="参考音频"></div>
  <section class="preview"><h2>模型试听</h2><label for="text">试听文本</label><textarea id="text" rows="3" maxlength="1200">The evening is quiet, and the last light of the sun settles over the city. For a moment, there is nothing left to fear.</textarea>
  <div class="actions"><button id="generate">生成试听</button><span id="status" role="status" aria-live="polite">正在读取参考音频…</span></div><audio id="result" controls hidden></audio></section></main>
  <script nonce="${nonce}" src="${media('references.js')}"></script></body></html>`;
}

module.exports={registerReferencePanel,loadReferences,referenceHtml};
