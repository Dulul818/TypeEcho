const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {requestSpeech,createSpeechCache}=require('../src/speech/tts');

async function main() {
  if(!process.argv[2])throw new Error('Usage: node test/gpt-sovits-live-smoke.js <settings.json>');
  const settings=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
  assert.equal(settings['codeType.ttsProvider'],'gpt-sovits');
  const options={provider:'gpt-sovits',rate:settings['codeType.ttsRate'] || 1,
    referenceAudio:settings['codeType.ttsReferenceAudio'],referenceText:settings['codeType.ttsReferenceText'],
    referenceLanguage:settings['codeType.ttsReferenceLanguage'] || 'en'};
  assert.ok(options.referenceAudio && options.referenceText && !options.referenceText.startsWith('Replace this'), 'Fill in the real reference audio and transcript first.');
  const endpoint=settings['codeType.ttsEndpoint'];
  let requests=0;
  const cache=createSpeechCache((...args)=>{requests++;return requestSpeech(...args);});
  const output=path.resolve('.test-output/gpt-sovits');await fs.mkdir(output,{recursive:true});
  const results=[];
  try {
    for(const [index,text] of ['the','in','is','it','a','and','or','We can begin today.','A man; a girl, and a ship.'].entries()) {
      const started=performance.now();
      const clip=await cache.get(endpoint,text,options);
      const ms=Math.round(performance.now()-started),wav=Buffer.from(clip.audio,'base64');
      assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.toString('ascii',8,12),'WAVE');
      let dataBytes=0,byteRate=0;
      for(let offset=12;offset+8<=wav.length;) {
        const tag=wav.toString('ascii',offset,offset+4),size=wav.readUInt32LE(offset+4);
        assert.ok(offset+8+size<=wav.length,'WAV chunk is complete');
        if(tag==='fmt ' && size>=16)byteRate=wav.readUInt32LE(offset+16);
        if(tag==='data')dataBytes=size;
        offset+=8+size+(size%2);
      }
      assert.ok(dataBytes && byteRate);
      const before=requests;
      assert.deepEqual(await cache.get(endpoint,text,options),clip);
      assert.equal(requests,before,'prepared audio is reused without another model request');
      const file=path.join(output,`${index+1}.wav`);await fs.writeFile(file,wav);
      const row={text,ms,seconds:+(dataBytes/byteRate).toFixed(3),file};
      results.push(row);console.log(JSON.stringify(row));
    }
    await fs.writeFile(path.join(output,'results.json'),JSON.stringify(results,null,2));
  } finally {cache.clear();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
