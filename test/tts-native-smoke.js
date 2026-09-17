const assert = require('node:assert/strict');
const { createSystemSpeaker } = require('../src/speech/tts');

async function main() {
  const errors = [];
  const events=[];
  let ended;
  const completion=new Promise(resolve=>ended=resolve);
  const speaker = createSystemSpeaker(error => errors.push(error),id=>{events.push(['end',id]);ended();},id=>events.push(['start',id]));
  const timeout=setTimeout(()=>ended(),10000);
  try {
    speaker.speak('hello world',{id:42,rate:1,volume:0});
    await completion;
    assert.deepEqual(events,[['start',42],['end',42]],'native playback emits real start and end notifications');
    speaker.stop();
    assert.deepEqual(errors, []);
    console.log('PASS: Windows English voice worker accepts words and cancellation without errors.');
  } finally { clearTimeout(timeout);speaker.dispose(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
