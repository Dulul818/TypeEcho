const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { baseVscode, uri } = require('./helpers');

function fixture(value) {
  const vscode = baseVscode();
  const root = path.resolve('project');
  const resource = uri(path.join(root, 'src', 'first.py'));
  const writes = [];
  const config = {
    get: () => value,
    inspect: () => ({}),
    update: async (key, next, target) => { writes.push({ key, next, target }); value = next; },
  };
  vscode.workspace.getConfiguration = () => config;
  vscode.workspace.getWorkspaceFolder = () => ({ uri: uri(root) });
  vscode.workspace.workspaceFolders = [{ uri: uri(root) }];
  vscode.Uri.file = uri;
  vscode.ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
  const context = { globalState: { get: () => ['legacy.py'], update: async () => {} } };
  return { vscode, context, resource, root, writes };
}

test('configured relay paths resolve from workspace, preserve order, deduplicate and override legacy files', () => {
  const { readRelayFiles } = require('../src/relay-files');
  const f = fixture(['src/a.py', 'src/a.py', path.resolve('external.py'), 'src/b.py']);
  assert.deepEqual(readRelayFiles(f.vscode, f.context, f.resource), [
    path.join(f.root, 'src/a.py'), path.resolve('external.py'), path.join(f.root, 'src/b.py'),
  ]);
  assert.deepEqual(readRelayFiles(fixture([]).vscode, f.context, f.resource), []);
  for (const value of [undefined, null]) {
    assert.deepEqual(readRelayFiles(fixture(value).vscode, f.context, f.resource), ['legacy.py']);
  }
});

test('relay rejects malformed config and relative paths without a workspace', () => {
  const { readRelayFiles } = require('../src/relay-files');
  for (const value of ['a.py', [null], [' ']]) {
    const f = fixture(value);
    assert.throws(() => readRelayFiles(f.vscode, f.context, f.resource), /codeType.relayFiles/);
  }
  const f = fixture(['src/a.py']);
  f.vscode.workspace.getWorkspaceFolder = () => undefined;
  f.vscode.workspace.workspaceFolders = [];
  assert.throws(() => readRelayFiles(f.vscode, f.context, f.resource), /绝对路径/);
});

test('picker saves portable workspace paths, clear persists an empty list, standalone uses user settings', async () => {
  const { writeRelayFiles } = require('../src/relay-files');
  const f = fixture(null);
  await writeRelayFiles(f.vscode, f.resource, [uri(path.join(f.root, 'src/a.py')), uri(path.resolve('outside.py'))]);
  assert.deepEqual(f.writes[0], { key: 'relayFiles', next: ['src/a.py', path.resolve('outside.py').replaceAll('\\', '/')], target: 3 });
  await writeRelayFiles(f.vscode, f.resource, []);
  assert.deepEqual(f.writes[1].next, []);
  f.vscode.workspace.getWorkspaceFolder = () => undefined;
  f.vscode.workspace.workspaceFolders = [];
  await writeRelayFiles(f.vscode, f.resource, [uri(path.resolve('outside.py'))]);
  assert.equal(f.writes[2].target, 1);
  assert.deepEqual(f.writes[2].next, [path.resolve('outside.py').replaceAll('\\', '/')]);
});

test('multi-root relay uses the starting document folder and updates an existing workspace setting', async () => {
  const { readRelayFiles, writeRelayFiles } = require('../src/relay-files');
  const f = fixture(['src/second.py']);
  const other = path.resolve('other-project');
  f.vscode.workspace.workspaceFolders.unshift({ uri: uri(other) });
  const getConfig = f.vscode.workspace.getConfiguration;
  let queried;
  f.vscode.workspace.getConfiguration = (section, resource) => {
    queried = resource.fsPath;
    const config = getConfig();
    config.inspect = () => ({ workspaceValue: ['src/second.py'] });
    return config;
  };
  assert.deepEqual(readRelayFiles(f.vscode, f.context, f.resource), [path.join(f.root, 'src/second.py')]);
  assert.equal(queried, f.root);
  await writeRelayFiles(f.vscode, f.resource, []);
  assert.equal(f.writes[0].target, 2, 'update the existing workspace setting instead of leaving a stale list');
});
