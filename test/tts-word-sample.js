const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');

async function main() {
  const endpoint=process.env.TTS_SMOKE_ENDPOINT || 'http://127.0.0.1:17864/tts';
  const payload={text:'the',language:'en-US',voice:process.env.TTS_SMOKE_VOICE || 'BG3N',rate:1};
  const request=async()=>{
    const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(30000)});
    assert.equal(response.status,200);
    assert.match(response.headers.get('content-type'),/^audio\/wav/);
    return {audio:Buffer.from(await response.arrayBuffer()),cache:response.headers.get('x-cache')};
  };
  const first=await request(),second=await request();
  assert.deepEqual(first.audio,second.audio,'repeated requests reuse identical generated audio');
  const output=path.resolve('.test-output/the-bg3-current.wav');
  await fs.mkdir(path.dirname(output),{recursive:true});
  await fs.writeFile(output,first.audio);
  let bytesPerSecond,dataBytes;
  for(let offset=12;offset+8<=first.audio.length;) {
    const name=first.audio.toString('ascii',offset,offset+4),size=first.audio.readUInt32LE(offset+4);
    if(name==='fmt ') bytesPerSecond=first.audio.readUInt32LE(offset+16);
    if(name==='data') dataBytes=size;
    offset+=8+size+(size%2);
  }
  console.log(JSON.stringify({output,payload,cache:[first.cache,second.cache],seconds:dataBytes/bytesPerSecond}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
