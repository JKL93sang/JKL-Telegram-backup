'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const filepath = __dirname + '/../JKL_Telegram_Backup.user.js';
let source = fs.readFileSync(filepath, 'utf8');
const suffix = '\n})();';
assert.ok(source.trimEnd().endsWith('})();'));
const index = source.lastIndexOf(suffix);
assert.ok(index > 0);
source = source.slice(0, index) + '\nwindow.__testing = {sanitize, dateStamp, getMediaInfo, fileName, saveMessage};' + source.slice(index);

const requests = [];
const browser = {
  appDownloadManager: { downloadToDisc: async options => { requests.push(options); } }
};
const sandbox = {
  window: browser,
  document: {
    body: {},
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; }
  },
  MutationObserver: class { observe() {} },
  console,
  setTimeout,
  clearTimeout,
  Element: class {},
  Date,
  Promise
};
vm.runInNewContext(source, sandbox, { filename: filepath });
const { sanitize, dateStamp, getMediaInfo, fileName, saveMessage } = browser.__testing;

(async () => {
  assert.equal(sanitize(' A/B:*?\\C '), 'A_B_C');
  assert.equal(sanitize('CON'), '_CON');
  assert.equal(dateStamp(0), 'date-inconnue');
  const date = new Date(2026, 9, 12, 10, 21, 4).getTime() / 1000;
  assert.equal(dateStamp(date), '2026-10-12_10-21-04');

  const photo = { _: 'photo', sizes: [] };
  const video = { _: 'document', mime_type: 'video/mp4', attributes: [{ _: 'documentAttributeFilename', file_name: 'x.mp4' }] };
  const webm = { _: 'document', mime_type: 'video/webm', attributes: [] };
  const pdf = { _: 'document', mime_type: 'application/pdf' };
  const msgPhoto = { mid: 25, date, media: { photo }, peerId: '-100123' };
  const msgVideo = { mid: 26, date, media: { document: video }, peerId: '-100123' };
  assert.equal(getMediaInfo(msgPhoto).type, 'PHOTO');
  assert.equal(getMediaInfo(msgVideo).type, 'VIDEO');
  assert.equal(getMediaInfo({media:{document:webm}}).ext, 'webm');
  assert.equal(getMediaInfo({media:{document:pdf}}), null);
  assert.equal(getMediaInfo({media:{}}), null);

  assert.equal(fileName(msgPhoto, getMediaInfo(msgPhoto)), 'Telegram_-100123_2026-10-12_10-21-04_PHOTO_25.jpg');
  assert.equal(fileName(msgVideo, getMediaInfo(msgVideo)), 'Telegram_-100123_2026-10-12_10-21-04_VIDEO_26.mp4');
  await saveMessage(msgPhoto);
  await saveMessage(msgVideo);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].media, photo);
  assert.equal(requests[1].media, video);
  assert.match(requests[1].fileName, /_VIDEO_26\.mp4$/);
  assert.equal((await saveMessage({mid:1,media:{document:pdf}})).skipped, true);
  assert.equal(requests.length, 2);
  console.log('OK: 16 controles (noms, dates, filtres media, moteur natif et extensions).');
})().catch(error => { console.error(error); process.exitCode = 1; });


// Verify a visible entry point is mounted even when Telegram internals are absent.
const widgets = new Map();
let appended = null;
class FakeElement {
  constructor() {
    this.style = {};
    this.dataset = {};
    this.hidden = true;
    this.textContent = '';
    this.listeners = {};
  }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(key, cb) { this.listeners[key] = cb; }
  querySelector(selector) {
    if (!widgets.has(selector)) widgets.set(selector, new FakeElement());
    return widgets.get(selector);
  }
  set innerHTML(html) { this.html = html; }
}
const fakeDocument = {
  body: {appendChild(el) { appended = el; }},
  documentElement: {dataset: {}},
  createElement() { return new FakeElement(); },
  getElementById(id) { return appended?.id === id ? appended : null; },
  addEventListener() {},
  querySelector() { return null; },
  querySelectorAll() { return []; }
};
const fakeLocation = {hostname: 'web.telegram.org', pathname: '/a/', hash: '#abc', href: 'https://web.telegram.org/a/#abc'};
vm.runInNewContext(source, {
  window: {},
  document: fakeDocument,
  location: fakeLocation,
  navigator: {clipboard: {writeText: async () => {}}},
  MutationObserver: class {observe() {}},
  Element: class {},
  console,
  setTimeout,
  clearTimeout,
  Promise,
  Date
}, {filename: filepath});
assert.equal(appended?.id, 'jkl-tg-dock');
assert.match(appended.html, /Télécharger le média survolé/);
assert.equal(fakeDocument.documentElement.dataset.jklTelegramBackup, '0.1.1');
const toggle = widgets.get('#jkl-tg-toggle');
toggle.listeners.click();
assert.match(widgets.get('#jkl-tg-status').textContent, /WebK : NON/);
assert.equal(widgets.get('#jkl-tg-webk').style.display, 'block');
fakeLocation.pathname = '/k/';
toggle.listeners.click();
toggle.listeners.click();
assert.match(widgets.get('#jkl-tg-status').textContent, /WebK : OK/);
assert.equal(widgets.get('#jkl-tg-webk').style.display, 'none');
console.log('OK: le panneau visible et le diagnostic WebA/WebK sont montés et interactifs.');
