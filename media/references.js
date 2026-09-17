(() => {
  const vscode=acquireVsCodeApi(),list=document.getElementById('references'),status=document.getElementById('status');
  const result=document.getElementById('result'),generate=document.getElementById('generate');
  let busy=false,hasSelection=false;
  const send=(type,data={})=>vscode.postMessage({type,...data});
  const element=(tag,text,className)=>{const node=document.createElement(tag);if(text)node.textContent=text;if(className)node.className=className;return node;};
  function clearPreview(){result.pause();result.removeAttribute('src');result.hidden=true;}
  document.addEventListener('play',event=>{for(const audio of document.querySelectorAll('audio'))if(audio!==event.target)audio.pause();},true);
  document.getElementById('import').onclick=()=>send('import');
  document.getElementById('settings').onclick=()=>send('settings');
  generate.onclick=()=>{if(busy)return;clearPreview();busy=true;generate.disabled=true;send('preview',{text:document.getElementById('text').value.trim()});};
  window.addEventListener('message',({data})=>{
    if(data.type==='references') {
      for(const audio of list.querySelectorAll('audio'))audio.pause();
      clearPreview();list.replaceChildren();hasSelection=data.selected>=0;
      document.getElementById('provider').textContent=data.provider==='gpt-sovits'?'GPT-SoVITS v2ProPlus':'当前使用其他语音接口';
      if(!data.rows.length)list.append(element('p','暂无参考录音'));
      for(const row of data.rows) {
        const item=element('section',null,'reference'),label=element('label',null,'choice'),radio=element('input');
        radio.type='radio';radio.name='reference';radio.checked=row.id===data.selected;radio.disabled=!row.exists;
        radio.onchange=()=>{clearPreview();send('select',{id:row.id});};
        label.append(radio,element('span',row.name),element('span',row.primary?'首选':'','badge'));
        item.append(label,element('p',row.text,'transcript'));
        const meta=[row.language,row.duration ? `${row.duration.toFixed(2)} 秒`:'',!row.exists?'文件不存在':''].filter(Boolean).join(' · ');
        item.append(element('p',meta,'meta'));
        if(row.exists){const audio=element('audio');audio.controls=true;audio.preload='none';audio.src=row.url;audio.setAttribute('aria-label',`${row.name} 原录音`);item.append(audio);}
        list.append(item);
      }
      generate.disabled=busy || !hasSelection;
      status.textContent=hasSelection?'参考音频已就绪':'请选择参考音频';
    } else if(data.type==='busy'){busy=data.value;generate.disabled=busy || !hasSelection;generate.textContent=busy?'正在生成…':'生成试听';}
    else if(data.type==='status'){status.textContent=data.text;status.classList.toggle('error',!!data.error);if(data.error){busy=false;generate.disabled=!hasSelection;generate.textContent='生成试听';}}
    else if(data.type==='preview'){result.src=`data:${data.mime};base64,${data.audio}`;result.hidden=false;result.play().catch(()=>{});}
  });
  send('ready');
})();
