const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {loadReferences,registerReferencePanel}=require('../src/views/reference-panel');

test('reference panel loads exact transcripts, resolves audio paths and switches audio/text atomically',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'code-type-references-'));
  try {
    const manifest=path.join(root,'references.json'),audio=path.join(root,'voice.wav');
    await fs.writeFile(audio,'test');
    await fs.writeFile(manifest,JSON.stringify([{audio:'voice.wav',text:'Actual spoken words.',language:'en',primary:true}]));
    const rows=await loadReferences(manifest);
    assert.equal(rows[0].audio,audio);assert.equal(rows[0].text,'Actual spoken words.');
    let receive,dispose;const messages=[],writes=[];
    const values={ttsProvider:'gpt-sovits',ttsReferenceLibrary:manifest};
    const uri=fsPath=>({fsPath,toString:()=>fsPath});
    const vscode={ViewColumn:{Beside:2},ConfigurationTarget:{Global:1},Uri:{file:uri,joinPath:(root,...parts)=>uri(path.join(root.fsPath,...parts))},
      workspace:{getConfiguration:()=>({get:key=>values[key],update:async(key,value)=>{values[key]=value;writes.push({key,value});}})},
      window:{createWebviewPanel:()=>({webview:{cspSource:'test:',options:{},asWebviewUri:uri=>uri,postMessage:message=>messages.push(message),onDidReceiveMessage:fn=>receive=fn},onDidDispose:fn=>{dispose=fn;}})}};
    const open=registerReferencePanel(vscode,{extensionUri:uri(process.cwd()),globalState:{get:()=>[]},subscriptions:[]});
    await open();await receive({type:'ready'});
    assert.equal(messages.at(-1).rows[0].exists,true);
    await receive({type:'select',id:0});
    assert.deepEqual(writes,[{key:'ttsReference',value:{audio,text:'Actual spoken words.',language:'en'}}]);
    assert.equal(messages.filter(row=>row.type==='references').at(-1).selected,0);
    await receive({type:'select',id:99});assert.equal(writes.length,1);
    await fs.writeFile(manifest,'{}');await assert.rejects(loadReferences(manifest),/JSON 数组/);
    dispose();
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
