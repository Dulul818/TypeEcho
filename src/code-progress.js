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
  return { cuts, progress };
}

module.exports = { codeProgress };
