const MAX_TEXT = 1200;

function speechWord(text) {
  return (text || '').replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
}

function sentenceWordCount(text) {
  return text.split(/\s+/).filter(word=>/[A-Za-z0-9]/.test(word)).length;
}

function sentenceEnds(words) {
  const text=words.join(' ');
  // Keep tokens intact: apostrophes, hyphens and decimal points inside words are not pauses.
  const protectedWords=text.replace(/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Mt|vs|etc|No|Fig|Inc|Ltd|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.|\b(?:[A-Za-z]\.){2,}/gi,match=>match.replace(/\./g,'\u00b7'))
    .replace(/\b[A-Z]\.(?=\s+[A-Z])/g,match=>match.replace('.','\u00b7')).split(' ');
  const ends=[];
  for (let i=0;i<protectedWords.length;i++) {
    const word=protectedWords[i];
    if (!/[\p{P}\p{S}]$/u.test(word) || /\u00b7$/.test(word) || /^["'([{<]+$/.test(word)) continue;
    // Consecutive marks and detached closing quotes/brackets stay with the preceding phrase.
    while (i+1<words.length && /^["')\]}>.,;:!?]+$/.test(words[i+1])) i++;
    ends.push(i+1);
  }
  return ends;
}

function splitSentences(words, complete=false) {
  const ends=sentenceEnds(words);
  if (complete && ends.at(-1)!==words.length) ends.push(words.length);
  const segments=[];
  let start=0;
  while (start<words.length) {
    const naturalEnd=ends.find(end=>end>start);
    let end=naturalEnd;
    if (!end || end-start>30 || words.slice(start,end).join(' ').length>MAX_TEXT) {
      if (!end && words.length-start<31 && words.slice(start).join(' ').length<=MAX_TEXT) break;
      const limit=Math.min(start+30,end || words.length);
      const pauses=[];
      for(let i=start+19;i<limit;i++) if (/[,;:]["')\]}]*$/.test(words[i])) pauses.push(i+1);
      end=pauses.sort((a,b)=>Math.abs(a-start-25)-Math.abs(b-start-25))[0] || Math.min(start+25,limit);
      while(end>start && words.slice(start,end).join(' ').length>MAX_TEXT) end--;
      if (end===start) break;
    }
    segments.push({start,end,text:words.slice(start,end).join(' ')});
    start=end;
  }
  return segments;
}

class SentenceContext {
  constructor() { this.reset(); }
  reset() { this.words=new Map(); this.segments=[]; this.next=undefined; this.end=undefined; }
  update(state) {
    const incoming=state.speechWords || state.preview || [];
    const changed=incoming.some(word=>this.words.has(word.index) && this.words.get(word.index)!==word.text);
    if (changed) this.reset();
    for(const word of incoming) if(Number.isInteger(word.index) && typeof word.text==='string') this.words.set(word.index,word.text);
    if(Number.isInteger(state.speechEnd)) this.end=state.speechEnd;
    if(this.next===undefined && this.words.size) this.next=Math.min(...this.words.keys());
    const available=[];
    for(let i=this.next; this.words.has(i); i++) available.push(this.words.get(i));
    for(const segment of splitSentences(available,this.next+available.length===this.end)) {
      this.segments.push({...segment,start:segment.start+this.next,end:segment.end+this.next});
    }
    if(this.segments.length) this.next=this.segments.at(-1).end;
    const index=state.wordIndex ?? 0;
    const sentence=this.segments.find(segment=>index>=segment.start && index<segment.end);
    const nextSentence=sentence && this.segments.find(segment=>segment.start===sentence.end);
    // Retain official words for this round so delayed FIFO playback can still be validated.
    const identify=segment=>segment ? {...segment,id:`${segment.start}:${segment.end}`,wordCount:sentenceWordCount(segment.text)} : null;
    return {sentence:identify(sentence),nextSentence:identify(nextSentence),changed};
  }
}

module.exports={splitSentences,SentenceContext,MAX_TEXT,speechWord,sentenceWordCount};
