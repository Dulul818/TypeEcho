(function (root) {
  function updateWordFeedback(history, state) {
    if (!state.target) return;
    const index = state.wordIndex ?? 0;
    if (history.has(index) && history.get(index).text !== state.target) history.clear();
    for (const [key, word] of history) {
      if (key < index && !word.complete) {
        word.complete = true;
        word.errors = Array.from(word.text, (char, i) => word.typed[i] !== char ? i : -1).filter(i => i >= 0);
      }
      if (key < index - 48 || key > index + 72) history.delete(key);
    }
    for (const word of state.preview || []) {
      if (word.index === index || !word.feedback) continue;
      history.set(word.index, { text:word.text, complete:word.feedback.complete,
        errors:word.feedback.errors, extra:word.feedback.extra, typed:word.feedback.typed || '' });
    }
    const typed = state.typed || '';
    history.set(index, { text:state.target, typed, complete:false,
      errors:Array.from(state.target, (char,i)=> i < typed.length && typed[i] !== char ? i : -1).filter(i=>i>=0),
      extra:Math.max(0,typed.length-state.target.length) });
  }
  const api = { updateWordFeedback };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.wordFeedback = api;
})(globalThis);
