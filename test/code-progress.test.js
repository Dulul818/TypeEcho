const {test} = require('node:test');
const assert = require('node:assert/strict');
const {codeProgress} = require('../src/code-progress');

test('line breaks and indentation reveal together, with ordinary spaces unchanged', () => {
  const source = 'a\n    b c\n\t\td\n  \t e';
  const {cuts} = codeProgress(source);
  const steps = cuts.slice(1).map((end, i) => source.slice(cuts[i], end));
  assert.deepEqual(steps, ['a','\n    ','b',' ','c','\n\t\t','d','\n  \t ','e']);
  assert.deepEqual(codeProgress('    x').cuts, [0,4,5]);
  assert.deepEqual(codeProgress('x\t\ty').cuts, [0,1,3,4]);
  assert.deepEqual(codeProgress('a  b').cuts, [0,1,2,3,4]);
});

test('old progress finishes partially revealed indentation without skipping code', () => {
  const source = 'a\n    b';
  for (let previous=0; previous<=source.length; previous++) {
    const migrated=codeProgress(source,{progress:previous});
    const expected=previous>1 && previous<6 ? 6 : previous;
    assert.equal(migrated.cuts[migrated.progress],expected);
    const restored=codeProgress(source,{offset:migrated.cuts[migrated.progress],progress:migrated.progress});
    assert.equal(restored.cuts[restored.progress],expected);
  }
  const partial=codeProgress(source,{progress:3});
  assert.equal(partial.cuts[partial.progress],6,'restoring completes the remaining indent immediately');
  assert.equal(partial.cuts[partial.progress-1],1,'backspace does not revisit a half-indent');
  const unicode=codeProgress('\u{1F600}\n    x',{progress:2});
  assert.equal(unicode.cuts[unicode.progress],7,'old code-point progress snaps to the indentation end');
  assert.equal(codeProgress(source,{offset:999}).progress,0);
});

test('nested blocks preserve source indentation and dedentation as full steps', () => {
  const source='for app in apps:\n    for entry in entries:\n        if not entry.id:\n            continue\n    done()';
  const {cuts}=codeProgress(source);
  for(const match of source.matchAll(/\n([ \t]*)/g)) {
    const end=match.index+match[0].length;
    assert.ok(cuts.includes(end));
    assert.ok(!cuts.some(offset=>offset>match.index && offset<end));
  }
});
