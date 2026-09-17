const { compressToURI } = require('lz-ts');

function settingsUrl(settings) {
  if (!settings || !['time', 'words', 'quote'].includes(settings.mode)) throw new Error('请选择 time、words 或 quote。');
  const allowed = settings.mode === 'time' ? [15, 30, 60, 120] : settings.mode === 'words' ? [10, 25, 50, 100] : ['all', 'short', 'medium', 'long', 'thicc'];
  if (!allowed.includes(settings.amount)) throw new Error('测试长度无效。');
  if (!['english', 'english_1k', 'english_5k', 'english_10k', 'english_25k'].includes(settings.language)) throw new Error('请选择支持的英文词库。');
  if (typeof settings.punctuation !== 'boolean' || typeof settings.numbers !== 'boolean') throw new Error('标点或数字设置无效。');
  // Official Share Test Settings format. Quote mode2 is a quote ID, not its length.
  const payload = [settings.mode, settings.mode === 'quote' ? null : settings.amount, null, settings.punctuation, settings.numbers, settings.language, null, null];
  return `https://monkeytype.com/?testSettings=${compressToURI(JSON.stringify(payload))}`;
}

function readAccountLevel() {
  const text = document.querySelector('[data-nav-item="account"] [data-ui-element="userLevel"]')?.textContent?.trim();
  return /^\d+$/.test(text || '') ? Number(text) : null;
}

// Serialized into the website context. Only public result elements are read.
function readResult() {
  if (location.origin !== 'https://monkeytype.com' || location.pathname !== '/') return null;
  const result = document.querySelector('#result');
  if (!result || !result.getClientRects().length || getComputedStyle(result).visibility === 'hidden') return null;
  const value = selector => (result.querySelector(selector)?.innerText || '').trim().replace(/\s+/g, ' ');
  const metrics = {
    wpm: value('.group.wpm .bottom'), accuracy: value('.group.acc .bottom'),
    raw: value('.group.raw .bottom'), characters: value('.group.key .bottom'),
    consistency: value('.group.consistency .bottom'), time: value('.group.time .bottom .text') || value('.group.time .bottom'),
    testType: value('.group.testType > .bottom'), source: value('.group.source .bottom'),
  };
  if (!/^\d/.test(metrics.wpm) || !/^\d/.test(metrics.accuracy)) return null;
  const visible = selector => { const el = result.querySelector(selector); return !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  return {
    metrics, loggedOut: visible('.loginTip'), retryVisible: visible('#retrySavingResultButton'),
    level: readAccountLevel(),
  };
}

module.exports = { settingsUrl, readResult, readAccountLevel };
