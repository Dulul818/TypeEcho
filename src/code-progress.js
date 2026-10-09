function codeProgress(source, saved) {
  const cuts = [0];
  // An editor inserts a line break and its indentation together. Keep ordinary spaces literal.
  for (const match of source.matchAll(/\n[ \t]*|^[ \t]+|\t+|[\s\S]/gmu)) cuts.push(match.index + match[0].length);
  let offset = 0;
  if (Number.isInteger(saved?.offset) && saved.offset >= 0 && saved.offset <= source.length) {
    offset = saved.offset;
  } else if (saved?.offset === undefined && Number.isInteger(saved?.progress) && saved.progress > 0) {
    const chars = Array.from(source);
    if (saved.progress <= chars.length) offset = chars.slice(0, saved.progress).join('').length;
  }
  // Finish a partially saved indentation rather than adding an unnatural intermediate stop.
  const progress = cuts.findIndex(end => end >= offset);
  const errors = new Map();
  for (const entry of Array.isArray(saved?.errors) ? saved.errors : []) {
    if (Array.isArray(entry) && Number.isInteger(entry[0]) && entry[0] >= 0 && entry[0] < progress &&
        typeof entry[1] === 'string' && /^[\x20-\x7e]$/.test(entry[1])) errors.set(entry[0], entry[1]);
  }
  return { cuts, progress, errors };
}

function codeText(source, cuts, progress, errors) {
  let text = '', start = 0;
  for (const [step, character] of [...errors].sort((a, b) => a[0] - b[0])) {
    if (step >= progress) continue;
    text += source.slice(start, cuts[step]) + character;
    start = cuts[step + 1];
  }
  return text + source.slice(start, cuts[progress]);
}

function codeTypo(source, cuts, progress, key, state) {
  if (!state.ready || !state.target) return;
  const typed = state.typed || '';
  const expected = key === ' ' && typed === state.target ? ' ' : state.target[typed.length];
  if (key === expected) return;
  // A wrong practice key can coincidentally match the code; keep the mistake visible.
  return key === source.slice(cuts[progress], cuts[progress + 1]) ? (key === '?' ? '!' : '?') : key;
}

module.exports = { codeProgress, codeText, codeTypo };
