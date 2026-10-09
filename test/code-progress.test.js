const {test} = require('node:test');
const assert = require('node:assert/strict');
const {codeProgress, codeText, codeTypo} = require('../src/code-progress');

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

test('typos replace code steps, including whitespace, without changing the source', () => {
  const source = 'a\n    b c';
  const {cuts, errors} = codeProgress(source);
  const state = {ready:true, target:'hello', typed:''};
  assert.equal(codeTypo(source, cuts, 0, 'h', state), undefined);
  assert.equal(codeTypo(source, cuts, 0, 'x', state), 'x');
  assert.equal(codeTypo(source, cuts, 0, 'a', state), '?');
  assert.equal(codeTypo('?', [0,1], 0, '?', state), '!');
  assert.equal(codeTypo(source, cuts, 0, ' ', {...state, typed:'hello'}), undefined);
  assert.equal(codeTypo(source, cuts, 0, ' ', {...state, typed:'he'}), ' ');
  assert.equal(codeTypo(source, cuts, 0, 'x', {...state, typed:'hello'}), 'x');
  errors.set(1, 'x');
  errors.set(0, '<');
  assert.equal(codeText(source, cuts, 3, errors), '<xb');
  errors.delete(1);
  assert.equal(codeText(source, cuts, 2, errors), '<\n    ');
  errors.delete(0);
  assert.equal(codeText(source, cuts, 2, errors), 'a\n    ');
  assert.equal(source, 'a\n    b c');
});

test('saved typo steps restore with progress and invalid entries are discarded', () => {
  const source = 'abc';
  const restored = codeProgress(source, {offset:2, errors:[[1,'x'],[0,'<'],[-1,'z'],[2,'z'],[0,'<script>'],null]});
  assert.equal(codeText(source, restored.cuts, restored.progress, restored.errors), '<x');
  assert.equal(codeProgress(source, {offset:0, errors:[[0,'x']]}).errors.size, 0);
  assert.equal(codeProgress(source, {offset:2}).errors.size, 0);
  assert.equal(codeProgress(source, {offset:2, errors:{0:'x'}}).errors.size, 0);
});
