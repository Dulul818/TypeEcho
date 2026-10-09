const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const SOURCES = [
  { id: 'cet4', name: 'CET-4', file: 'CET4_T.json' },
  { id: 'cet4-memory', name: '四级巧记速记', file: 'xinghuoqiaoji_4.json' },
];
const CATALOG = SOURCES.flatMap(source => ['words', 'sentences'].map(kind => ({
  id: `${source.id}-${kind}`, name: `${source.name} · ${kind === 'words' ? '单词' : '例句'}`, kind,
  source: `https://files.typewords.cc/dicts/en/word/${source.file}`,
})));
const MAX_BYTES = 20 * 1024 * 1024;
const normalize = text => typeof text === 'string' ? text.normalize('NFKC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/[–—]/g, '-').replace(/…/g, '...').replace(/\s+/g, ' ').trim() : '';

function parseEntries(data, kind) {
  if (!['words', 'sentences'].includes(kind)) throw new Error('请选择单词或例句库。');
  if (typeof data === 'string') {
    const text = data.replace(/^\uFEFF/, '');
    data = /^[\s]*[\[{]/.test(text) ? JSON.parse(text) : kind === 'words' ? text.split(/\s+/) : text.split(/\r?\n/);
  }
  if (!Array.isArray(data)) data = data?.entries || data?.words;
  if (!Array.isArray(data) || data.length > 100000) throw new Error('文件需为 TXT 或词条 JSON 数组，最多 100,000 条。');
  const entries = [], seen = new Set();
  let skipped = 0;
  for (const item of data) {
    const rows = kind === 'sentences' && Array.isArray(item?.sentences) ? item.sentences : [item];
    for (const row of rows) {
      const text = normalize(typeof row === 'string' ? row : row?.text || (kind === 'words' ? row?.word : row?.c));
      const valid = kind === 'words' ? /^[A-Za-z]+(?:[' -][A-Za-z]+)*-?$/.test(text) : /^[\x20-\x7e]+$/.test(text) && !text.includes('|') && text.split(' ').length >= 2;
      if (!valid || text.length > (kind === 'words' ? 80 : 1200) || text.split(' ').some(word => word.length > 80)) { skipped++; continue; }
      const key = kind === 'words' ? text.toLowerCase() : text;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ text, translation: String(row?.translation || row?.cn || (Array.isArray(row?.trans) ? row.trans.map(t => `${t.pos || ''} ${t.cn || ''}`.trim()).join('；') : '')).slice(0,2000),
        headword: normalize(row?.headword || (kind === 'sentences' ? item?.word : '')) });
    }
  }
  if (!entries.length) throw new Error('未找到可练习的英文内容。单词 TXT 用空格或换行分隔；例句 TXT 每行一句。');
  return { entries, skipped };
}

class DictionaryStore {
  constructor(directory) { this.directory = directory; }
  file(id) {
    if (!/^[a-z0-9-]{1,100}$/.test(id)) throw new Error('词库标识无效。');
    return path.join(this.directory, `${id}.json`);
  }
  async save(library) {
    await fs.mkdir(this.directory, { recursive: true });
    const file = this.file(library.id), temporary = `${file}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(library));
    await fs.rename(temporary, file);
    return library;
  }
  async read(id) {
    const file = this.file(id);
    if ((await fs.stat(file)).size > MAX_BYTES) throw new Error('词库文件超过 20 MiB。');
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    return { ...data, id, ...parseEntries(data.entries, data.kind) };
  }
  async list() {
    const catalog = CATALOG.map(item => ({ ...item }));
    let files;
    try { files = await fs.readdir(this.directory); } catch (error) { if (error.code === 'ENOENT') return catalog; throw error; }
    for (const file of files.filter(file => /^[a-z0-9-]+\.json$/.test(file))) {
      const library = await this.read(file.slice(0, -5));
      const item = { id: library.id, name: library.name, kind: library.kind, source: library.source, count: library.entries.length };
      const at = catalog.findIndex(row => row.id === item.id);
      if (at < 0) catalog.push(item); else catalog[at] = item;
    }
    return catalog;
  }
  async ensure(id) {
    try { return await this.read(id); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const selected = CATALOG.find(item => item.id === id);
    if (!selected) throw new Error('找不到本地词库。');
    const response = await fetch(selected.source, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`词库下载失败（${response.status}），请稍后重试或导入本地文件。`);
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) throw new Error('下载的词库超过 20 MiB。');
      chunks.push(chunk);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    for (const item of CATALOG.filter(item => item.source === selected.source)) {
      // Existing local imports are never overwritten by a background download.
      try { await fs.access(this.file(item.id)); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await this.save({ ...item, ...parseEntries(data, item.kind), downloadedAt: new Date().toISOString() });
      }
    }
    return this.read(id);
  }
  async importFile(file, kind) {
    if ((await fs.stat(file)).size > MAX_BYTES) throw new Error('导入文件不能超过 20 MiB。');
    const parsed = parseEntries(await fs.readFile(file, 'utf8'), kind);
    return this.save({ id: `local-${crypto.randomUUID()}`, name: path.basename(file, path.extname(file)), kind, source: '本地导入', ...parsed });
  }
  async practiceFile(id) {
    const library = await this.read(id);
    const file = this.file(id).replace(/\.json$/, '.txt');
    // Native pipe delimiter keeps phrases and whole examples together.
    await fs.writeFile(file, library.entries.map(entry => entry.text).join('|'));
    return file;
  }
}

async function chooseDictionary(vscode, store) {
  const libraries = await store.list();
  const picked = await vscode.window.showQuickPick([
    ...libraries.map(item => ({ label: item.name, description: item.count ? `${item.count} 条 · 已在本地` : '首次自动下载', detail: item.source, id: item.id })),
    { label: '导入本地 TXT / JSON…', id: 'import' },
    { label: '导出词库 TXT / JSON…', id: 'export' },
  ], { title: 'TypeEcho · 词库与导入', placeHolder: '选择词库及官网出词方式；词库保存在本机，不随 Monkeytype 账号同步' });
  if (!picked) return;
  let library;
  if (picked.id === 'export') {
    const item = await vscode.window.showQuickPick(libraries.filter(item => item.count).map(item => ({ label: item.name, id: item.id })), { title: '选择要导出的本地词库' });
    if (!item) return;
    library = await store.read(item.id);
    const destination = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(store.directory, `${library.id}.txt`)), filters: { 'TXT（练习文本）': ['txt'], 'JSON（含翻译）': ['json'] } });
    if (destination) await fs.writeFile(destination.fsPath, destination.fsPath.endsWith('.json') ? JSON.stringify(library, null, 2) : library.entries.map(e => e.text).join('\n'));
    return;
  }
  if (picked.id === 'import') {
    const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { '词库': ['txt', 'json'] }, title: '导入英文词库或例句' });
    if (!files?.length) return;
    const kind = await vscode.window.showQuickPick([{ label: '单词', kind: 'words' }, { label: '例句（TXT 每行一句）', kind: 'sentences' }], { title: '导入内容类型' });
    if (!kind) return;
    library = await store.importFile(files[0].fsPath, kind.kind);
    void vscode.window.showInformationMessage(`已导入 ${library.entries.length} 条${library.skipped ? `，跳过 ${library.skipped} 条不支持的内容` : ''}。`);
  } else {
    library = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在准备本地词库…' }, () => store.ensure(picked.id));
  }
  const order = await vscode.window.showQuickPick([
    { label: 'shuffle · 官网乱序', description: '每局由官网打乱；跨局可能重复', value: 'shuffle' },
    { label: 'random · 官网随机', description: '由官网随机抽取', value: 'random' },
    { label: 'repeat · 官网顺序', description: '按原顺序生成；下一局仍从开头开始', value: 'repeat' },
  ], { title: library.name, placeHolder: '直接使用 Monkeytype 的出词规则' });
  if (!order) return;
  const counts = library.kind === 'words' ? [20, 50, 100] : [1, 3, 5];
  const size = await vscode.window.showQuickPick(counts.map(value => ({ label: `${value} ${library.kind === 'words' ? '条' : '句'} / 局`, value })), { title: library.name });
  if (!size) return;
  return { id: library.id, name: library.name, kind: library.kind, total: library.entries.length, size: size.value, order: order.value, native: true };

}

module.exports = { CATALOG, DictionaryStore, parseEntries, chooseDictionary };
