const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { decompressFromURI } = require('lz-ts');
const { parseEntries, DictionaryStore, CATALOG, chooseDictionary } = require('../src/dictionaries');
const { settingsUrl } = require('../src/site');

test('dictionary imports keep contractions, translations and sentences; invalid input is bounded', () => {
  const source = [{ word: 'don’t', trans: [{ pos: 'v.', cn: '不要' }], sentences: [{ c: '“Don’t cancel it.”', cn: '不要取消它。' }] }, { word: 'cancel' }];
  const words = parseEntries(source, 'words');
  assert.deepEqual(words.entries.map(e => e.text), ["don't", 'cancel']);
  assert.equal(words.entries[0].translation, 'v. 不要');
  const sentences = parseEntries(source, 'sentences');
  assert.deepEqual(sentences.entries, [{ text: '"Don\'t cancel it."', translation: '不要取消它。', headword: "don't" }]);
  assert.equal(parseEntries('the THE\nship 中文 <script> a/b', 'words').entries.length, 2);
  assert.equal(parseEntries('A whole sentence.\nAnother one!', 'sentences').entries.length, 2);
  assert.throws(() => parseEntries('{}', 'words'));
  assert.throws(() => parseEntries('中文', 'sentences'));
  assert.throws(() => settingsUrl({ mode: 'custom', text: ['bad word'] }));
  assert.throws(() => settingsUrl({ mode: 'custom', text: ['中文'] }));
});

test('local libraries survive reload, native import preserves sections and native options pass through', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'typeecho-dicts-'));
  const store = new DictionaryStore(directory);
  const library = await store.save({ ...CATALOG[0], ...parseEntries('one two three four five', 'words') });
  assert.equal((await new DictionaryStore(directory).read(library.id)).entries.length, 5);
  assert.equal((await store.list()).find(item => item.id === library.id).count, 5);
  assert.throws(() => store.file('../escape'));
  assert.equal(await fs.readFile(await store.practiceFile(library.id), 'utf8'), 'one|two|three|four|five');
  const imported = await store.importFile(store.file(library.id), 'words');
  assert.deepEqual(imported.entries, library.entries);
  const choices = [library.id, 'shuffle', 20];
  const vscode = { ProgressLocation: { Notification: 1 }, window: {
    showQuickPick: async items => { const choice = choices.shift(); return items.find(i => i.id === choice || i.value === choice || i.offset === choice); },
    withProgress: async (_options, work) => work(),
  } };
  const chosen = await chooseDictionary(vscode, store, { get: () => ({ offset: 3 }) });
  assert.equal(chosen.order, 'shuffle');
  assert.equal(chosen.native, true);
  assert.equal(chosen.offset, undefined);
  assert.equal(chosen.size, 20);
});
