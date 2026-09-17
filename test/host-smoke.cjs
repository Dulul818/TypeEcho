const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { BrowserBridge, findBrowser } = require('../src/browser');

exports.run = async function () {
  const extension = vscode.extensions.getExtension('local-prototype.code-type-bridge');
  assert.ok(extension, 'VS Code discovers the extension');
  assert.equal(extension.packageJSON.displayName, 'TypeEcho 键语');
  assert.equal(extension.packageJSON.version, require('../package.json').version);
  const api = await extension.activate();
  assert.equal(typeof api.htmlFor, 'function');
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('codeType.start'));
  const browser = new BrowserBridge();
  try {
    await browser.launch(findBrowser(), path.resolve(__dirname, '../.test-output/host-browser-profile'), ['--headless=new', '--disable-gpu']);
    await browser.attach();
    const version = await browser.call('Browser.getVersion');
    fs.writeFileSync(path.resolve(__dirname, '../.test-output/host-smoke.json'), JSON.stringify({ passed: true, version:extension.packageJSON.version, vscode: vscode.version, node: process.version, browser: version.product, activated: extension.isActive }, null, 2));
  } finally { await browser.close(); }
};
