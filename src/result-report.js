const fs = require('node:fs/promises');
const path = require('node:path');

const escape = text => String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function writeReport(directory, record) {
  await fs.mkdir(directory, { recursive: true });
  const stem = record.id;
  if (!/^[a-zA-Z0-9_-]+$/.test(stem)) throw new Error('报告文件名无效。');
  const files = { json: path.join(directory, `${stem}.json`), html: path.join(directory, `${stem}.html`) };
  const { png, files: ignored, ...data } = record;
  await fs.writeFile(files.json, JSON.stringify(data, null, 2), 'utf8');
  const metrics = Object.entries(record.metrics).filter(([, value]) => value).map(([key, value]) => `<tr><th>${escape(key)}</th><td>${escape(value)}</td></tr>`).join('');
  await fs.writeFile(files.html, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Typing test report</title>
  <style>body{font:14px system-ui,sans-serif;color:#202020;margin:32px}h1{font-size:22px}img{display:block;width:100%;max-width:1200px;margin:20px 0}table{border-collapse:collapse}th,td{text-align:left;padding:5px 20px 5px 0}th{font-weight:500;color:#555}button{padding:8px 16px}@media print{button{display:none}body{margin:0}img{max-height:135mm;object-fit:contain}}@page{size:landscape;margin:12mm}</style>
  <h1>Typing test report</h1><p>${escape(record.createdAt)}</p><p>${escape(record.receipt?.text || record.accountStatus)}</p>
  <p>${record.level != null ? `Level ${escape(record.level)}` : ''}</p><table>${metrics}</table><p><button onclick="window.print()">打印 / 另存为 PDF</button></p></html>`, 'utf8');
  return files;
}

module.exports = { writeReport };
