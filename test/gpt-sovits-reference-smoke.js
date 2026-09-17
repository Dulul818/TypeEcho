const fs=require('node:fs/promises');
const path=require('node:path');
const {requestSpeech}=require('../src/speech/tts');
const {loadReferences}=require('../src/views/reference-panel');
async function main(){
  if(!process.argv[2])throw new Error('Usage: node test/gpt-sovits-reference-smoke.js <settings.json> [text]');
  const settings=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
  const rows=await loadReferences(settings['codeType.ttsReferenceLibrary']);
  const text=process.argv[3] || 'The evening is quiet, and the last light of the sun settles over the city.';
  const output=path.resolve('.test-output/gpt-sovits');await fs.mkdir(output,{recursive:true});
  const results=[];
  for(const row of [...rows.filter(row=>!row.primary),...rows.filter(row=>row.primary)]){
    const started=performance.now();
    const clip=await requestSpeech(settings['codeType.ttsEndpoint'],text,new AbortController().signal,
      {provider:'gpt-sovits',referenceAudio:row.audio,referenceText:row.text,referenceLanguage:row.language,rate:1});
    const file=path.join(output,`${row.name}-preview.wav`);
    await fs.writeFile(file,Buffer.from(clip.audio,'base64'));
    const result={reference:row.name,text,ms:Math.round(performance.now()-started),file};
    results.push(result);console.log(JSON.stringify(result));
  }
  await fs.writeFile(path.join(output,'reference-results.json'),JSON.stringify(results,null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
