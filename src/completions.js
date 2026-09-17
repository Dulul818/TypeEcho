function suggestions(source, offset, nativeItems = []) {
  const prefix = source.slice(0, offset).match(/[A-Za-z_$][\w$]*$/)?.[0];
  if (!prefix || prefix.length < 2) return [];
  const output = [];
  const seen = new Set();
  for (const item of nativeItems) {
    const label = typeof item.label === 'string' ? item.label : item.label?.label;
    if (!label || !label.toLowerCase().startsWith(prefix.toLowerCase()) || label === prefix || seen.has(label)) continue;
    seen.add(label);
    output.push({ label: label.slice(0, 100), detail: String(item.detail || '').slice(0, 160), kind: item.kind, origin: 'VS Code' });
    if (output.length === 6) return output;
  }
  for (const match of source.matchAll(/[A-Za-z_$][\w$]{2,}/g)) {
    const label = match[0];
    if (!label.startsWith(prefix) || label === prefix || seen.has(label)) continue;
    seen.add(label);
    output.push({ label, detail: '当前文件', origin: 'file' });
    if (output.length === 6) break;
  }
  return output;
}

module.exports = { suggestions };
