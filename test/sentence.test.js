const {test}=require('node:test');
const assert=require('node:assert/strict');
const {splitSentences,SentenceContext,speechWord,sentenceWordCount}=require('../src/speech/sentence');
const split=text=>splitSentences(text.split(' '),true).map(segment=>segment.text);
const words=text=>text.split(' ').map((text,index)=>({text,index}));

test('word speech removes outer punctuation but preserves internal spelling and numbers',()=>{
  for (const [input,expected] of [['word.','word'],['"hello;"','hello'],['.', ''],[';:', ''],["don't","don't"],['well-known','well-known'],['3.14','3.14'],['(U.S.)','U.S'],['a:','a']]) assert.equal(speechWord(input),expected);
  assert.deepEqual(split('One; two: three.'),['One;','two:','three.']);
  assert.deepEqual(split('One ; two : three .'),['One ;','two :','three .']);
});

test('English sentences retain quotes and brackets, protect abbreviations, decimals and ellipses',()=>{
  assert.deepEqual(split('Dr. Smith paid 3.14 dollars. "Really?!" (Yes!) next sentence without punctuation'),
    ['Dr. Smith paid 3.14 dollars.','"Really?!"','(Yes!)','next sentence without punctuation']);
  assert.deepEqual(split('Mr. A. Smith uses e.g. the U.S. format. Wait... Really? Yes.'),
    ['Mr. A. Smith uses e.g. the U.S. format.','Wait...','Really?','Yes.']);
  assert.deepEqual(split('first. second! third?'),['first.','second!','third?']);
});

test('all punctuation separates phrases while complete words and closing marks stay intact',()=>{
  assert.deepEqual(split('Hello, world; next: stop! Wait... (really?) "yes" done / finish - end'),
    ['Hello,','world;','next:','stop!','Wait...','(really?)','"yes"','done /','finish -','end']);
  assert.deepEqual(split("Don't split well-known words or 3.14 numbers, please."),
    ["Don't split well-known words or 3.14 numbers,",'please.']);
  assert.deepEqual(split('She said " hello, " then left.'),['She said " hello, "','then left.']);
  assert.equal(splitSentences(['hello,','world'],false)[0].text,'hello,','comma completes a phrase before the remaining preview is known');
});

test('long sentences prefer natural pauses near 25 words, never truncate tokens or pending previews',()=>{
  const tokens=Array.from({length:65},(_,i)=>`word${i}${i===21?';':i===64?'.':''}`);
  const segments=splitSentences(tokens,true);
  assert.equal(segments[0].end,22);
  assert.ok(segments.every(segment=>segment.end-segment.start<=30));
  assert.equal(segments.map(segment=>segment.text).join(' '),tokens.join(' '));
  assert.deepEqual(splitSentences(tokens.slice(0,17),false),[]);
  assert.equal(splitSentences(tokens.slice(0,17),true).length,1);
  const huge=Array.from({length:30},()=> 'x'.repeat(80));
  assert.ok(splitSentences(huge,true).every(segment=>segment.text.length<=1200));
});

test('sentence context bridges preview windows, remembers starts and resets on changed official text',()=>{
  const context=new SentenceContext();
  const source=words('Dr. Smith paid 3.14 dollars for this item and then went home. Next sentence has no punctuation');
  assert.equal(context.update({wordIndex:0,speechWords:source.slice(0,6)}).sentence,null,'partial window is not an end');
  const first=context.update({wordIndex:1,speechWords:source.slice(4,15)}).sentence;
  assert.equal(first.text,'Dr. Smith paid 3.14 dollars for this item and then went home.');
  assert.equal(context.update({wordIndex:7,speechWords:source.slice(7,15)}).sentence.id,first.id);
  const tail=context.update({wordIndex:12,speechWords:source.slice(9),speechEnd:source.length}).sentence;
  assert.equal(tail.text,'Next sentence has no punctuation');
  assert.equal(context.update({wordIndex:2,speechWords:source.slice(0,8)}).sentence.id,first.id,'backspace preserves exact segment identity');
  assert.equal(context.update({wordIndex:0,speechWords:words('New test.'),speechEnd:2}).changed,true);
  context.reset();
  assert.equal(context.update({wordIndex:0,speechWords:source.slice(0,6)}).sentence,null);
});

test('next sentence is exposed only when its complete official segment is available',()=>{
  const context=new SentenceContext();
  const source=words('today. Tomorrow is sunny; Later: done.');
  let state=context.update({wordIndex:0,speechWords:source.slice(0,3)});
  assert.equal(state.nextSentence,null);
  state=context.update({wordIndex:0,speechWords:source,speechEnd:source.length});
  assert.deepEqual(state.nextSentence,{start:1,end:4,text:'Tomorrow is sunny;',id:'1:4',wordCount:3});
  assert.equal(context.update({wordIndex:3,speechWords:source}).nextSentence.text,'Later:');
  assert.equal(context.update({wordIndex:4,speechWords:source}).nextSentence.text,'done.');
});

test('standalone punctuation does not inflate the sentence word count',()=>{
  assert.equal(sentenceWordCount('girl,'),1);
  assert.equal(sentenceWordCount('" girl , "'),1);
  assert.equal(sentenceWordCount('a man;'),2);
  assert.equal(sentenceWordCount('and a ship'),3);
  assert.equal(sentenceWordCount(';'),0);
});
