const path = require('node:path');

function location(vscode, resource) {
  const folder = (resource && vscode.workspace.getWorkspaceFolder?.(resource)) || vscode.workspace.workspaceFolders?.[0];
  return { folder, config: vscode.workspace.getConfiguration('codeType', folder?.uri || resource) };
}

function readRelayFiles(vscode, context, resource) {
  const { folder, config } = location(vscode, resource);
  const selected = config.get('relayFiles');
  if (selected == null) return context.globalState.get('relayFiles') || [];
  if (!Array.isArray(selected) || selected.some(file => typeof file !== 'string' || !file.trim())) {
    throw new Error('codeType.relayFiles 必须是文件路径数组；留空数组 [] 可关闭接力。');
  }
  return [...new Set(selected.map(file => {
    if (!path.isAbsolute(file) && !folder) throw new Error('未打开工作区时，codeType.relayFiles 请使用绝对路径。');
    return vscode.Uri.file(path.isAbsolute(file) ? file : path.resolve(folder.uri.fsPath, file)).toString();
  }))];
}

async function writeRelayFiles(vscode, resource, files) {
  const { folder, config } = location(vscode, resource);
  const paths = files.map(file => {
    if (folder) {
      const relative = path.relative(folder.uri.fsPath, file.fsPath);
      if (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)) return relative.replaceAll('\\', '/');
    }
    return file.fsPath.replaceAll('\\', '/');
  });
  const scope = config.inspect('relayFiles');
  const target = folder
    ? (scope?.workspaceFolderValue === undefined && scope?.workspaceValue !== undefined
      ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.WorkspaceFolder)
    : vscode.ConfigurationTarget.Global;
  await config.update('relayFiles', [...new Set(paths)], target);
}

module.exports = { readRelayFiles, writeRelayFiles };
