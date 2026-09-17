const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

function loadExtension(vscode, browserModule, overrides={}) {
  const filename = path.resolve(__dirname, '../src/extension.js');
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  const wrapper = vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(filename, 'utf8')}\n})`, { filename });
  wrapper(name => overrides[name] || (name === 'vscode' ? vscode : name === './browser' && browserModule ? browserModule : localRequire(name)), module, module.exports);
  return module.exports;
}

const uri = fsPath => ({ fsPath, toString: () => fsPath });
function baseVscode() {
  return {
    ThemeColor: class ThemeColor { constructor(id) { this.id=id; } },
    Uri: { joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    workspace: { getConfiguration: () => ({ get: name => ({ fontSize: 14, fontFamily: 'Consolas, monospace', tabSize: 2 })[name] }) },
  };
}
module.exports = { loadExtension, baseVscode, uri };
