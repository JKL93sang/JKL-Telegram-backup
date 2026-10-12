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
source = source.slice(0, index) + '\nwindow.__testing = {sanitize, dateStamp, getMediaInfo, fileName, saveMessage, profileDownloadPath, downloadBlobIntoProfile, currentChatLabel, containsReadableProfileText, readPeerUsername, resolveProfileFolder, knownProfileFolder};' + source.slice(index);

const requests = [];
const browser = {
  appDownloadManager: { downloadMedia: async options => {
    requests.push(options);
    return {size: 600, slice() {return this;}};
  } }
};
const sandbox = {
  window: browser,
  document: {
    body: {},
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; }
  },
  localStorage: (() => {
    const data = new Map();
    return {data, getItem(k) {return data.get(k) ?? null;}, setItem(k,v) {data.set(k,String(v));}, removeItem(k) {data.delete(k);}};
  })(),
  MutationObserver: class { observe() {} },
  console,
  setTimeout: (fn, ms) => ms > 10000 ? 0 : setTimeout(fn, ms),
  clearTimeout,
  Element: class {},
  Date,
  Promise
};
vm.runInNewContext(source, sandbox, { filename: filepath });
const { sanitize, dateStamp, getMediaInfo, fileName, saveMessage, profileDownloadPath, downloadBlobIntoProfile, currentChatLabel, containsReadableProfileText, readPeerUsername, resolveProfileFolder, knownProfileFolder } = browser.__testing;
const folderStore = sandbox.localStorage.data;

const completed = [];
sandbox.GM_info = { downloadMode: 'browser' };
sandbox.GM_download = args => {
  completed.push(args);
  args.onload();
};

(async () => {
  assert.equal(sanitize(' A/B:*?\\C '), 'A_B_C');
  assert.equal(sanitize('CON'), '_CON');
  assert.equal(dateStamp(0), 'date-inconnue');
  const date = new Date(2026, 9, 12, 10, 21, 4).getTime() / 1000;
  assert.equal(dateStamp(date), '2026-10-12_10-21-04');

  const photo = { _: 'photo', sizes: [{_: 'photoSize',type:'x',size:600}] };
  const video = { _: 'document', size: 600, mime_type: 'video/mp4', attributes: [{ _: 'documentAttributeFilename', file_name: 'x.mp4' }] };
  const webm = { _: 'document', mime_type: 'video/webm', attributes: [] };
  const pdf = { _: 'document', mime_type: 'application/pdf' };
  const msgPhoto = { mid: 25, date, media: { photo }, peerId: '-100123' };
  const msgVideo = { mid: 26, date, media: { document: video }, peerId: '-100123' };
  assert.equal(getMediaInfo(msgPhoto).type, 'PHOTO');
  assert.equal(getMediaInfo(msgVideo).type, 'VIDEO');
  assert.equal(getMediaInfo({media:{document:webm}}).ext, 'webm');
  assert.equal(getMediaInfo({media:{document:pdf}}), null);
  assert.equal(getMediaInfo({media:{}}), null);

  assert.equal(fileName(msgPhoto, getMediaInfo(msgPhoto)), 'Profil_-100123 - 2026-10-12_10-21-04 - photo_25.jpg');
  assert.equal(fileName(msgVideo, getMediaInfo(msgVideo)), 'Profil_-100123 - 2026-10-12_10-21-04 - x.mp4');
  await saveMessage(msgPhoto);
  await saveMessage(msgVideo);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].media, photo);
  assert.equal(requests[1].media, video);
  assert.equal(requests[0].thumb.type, 'x');
  assert.equal(requests[0].fileName, undefined, 'media API does not accept an output filename');
  assert.equal(completed[0].name, 'Profil_-100123/Profil_-100123 - 2026-10-12_10-21-04 - photo_25.jpg');
  assert.equal(completed[1].name, 'Profil_-100123/Profil_-100123 - 2026-10-12_10-21-04 - x.mp4');
  assert.equal(completed[0].url.size, 600);
  assert.equal(completed[1].url.size, 600);
  assert.equal(completed[0].conflictAction, 'uniquify');
  assert.equal(completed[0].saveAs, false);
  assert.equal(completed.length, 2);
  assert.equal((await saveMessage({mid:1,media:{document:pdf}})).skipped, true);
  assert.equal(requests.length, 2);

  // Simulate a fresh profile without prior v0.2.4 directory selection.
  folderStore.clear();

  // Original document names must be respected, sanitized and safely suffixed.
  sandbox.document.querySelector = selector =>
    selector === '#column-center .chat-info .peer-title'
      ? { textContent: 'Canal Démo / Test' } : null;
  assert.equal(fileName(msgVideo, getMediaInfo(msgVideo)),
    'Canal Démo _ Test - 2026-10-12_10-21-04 - x.mp4');
  const pathVideo = {mid: 28, date, media: {
    document: {
      _: 'document', mime_type: 'video/mp4',
      attributes: [{_: 'documentAttributeFilename', file_name: 'C:\\\\Users\\\\Bob\\\\réunion originale.MP4'}]
    }
  }};
  assert.equal(fileName(pathVideo, getMediaInfo(pathVideo)),
    'Canal Démo _ Test - 2026-10-12_10-21-04 - réunion originale.mp4');
  const noOrig = {mid: 29, date, media: {
    document: {_: 'document', mime_type:'video/webm', attributes:[]}
  }};
  assert.equal(fileName(noOrig, getMediaInfo(noOrig)),
    'Canal Démo _ Test - 2026-10-12_10-21-04 - video_29.webm');
  const deceptive = {mid: 31, date, media: {
    document: {_: 'document', mime_type:'video/mp4', file_name:'video.exe', attributes:[]}
  }};
  assert.equal(fileName(deceptive, getMediaInfo(deceptive)),
    'Canal Démo _ Test - 2026-10-12_10-21-04 - video.mp4');
  const huge = {mid: 99, date, media: {document: {
    _: 'document', mime_type:'video/mp4', size: 700 * 1024 * 1024,
    file_name:'trop-grand.mp4', attributes:[]
  }}};
  await assert.rejects(() => saveMessage(huge), /512 Mio/);
  assert.equal(requests.length, 2, 'oversized files must be blocked before memory allocation');
  assert.equal(completed.length, 2);
  const badSize = {mid: 44, date, media: {document: {
    _: 'document', mime_type:'video/mp4', size: 999,
    file_name:'incomplet.mp4', attributes:[]
  }}};
  await assert.rejects(() => saveMessage(badSize), /Taille vidéo incohérente/);
  assert.equal(completed.length, 2, 'truncated downloads must never be offered to Firefox');
  assert.equal(profileDownloadPath('Canal Démo / Test', 'exemple.mp4'),
    'Canal Démo _ Test/exemple.mp4');
  assert.equal(profileDownloadPath('../../Autre', 'photo.jpg'),
    '_.._Autre/photo.jpg'); // no directory traversal from profile names
  await saveMessage(msgVideo);
  assert.equal(completed.at(-1).name,
    'Canal Démo _ Test/Canal Démo _ Test - 2026-10-12_10-21-04 - x.mp4');

  // Errors must never trigger a silent flat-download fallback.
  const count = completed.length;
  sandbox.GM_download = args => args.onerror({error:'not_permitted'});
  await assert.rejects(() => saveMessage(msgVideo), /not_permitted/);
  assert.equal(completed.length, count);
  // Tampermonkey protects downloadable extensions separately from Browser API.
  // Error must state which safe video extension to add, without unsafe fallback.
  sandbox.GM_download = args => args.onerror({error:'not_whitelisted'});
  await assert.rejects(() => saveMessage(msgVideo), err =>
    /Extension [.]mp4 non autorisée/.test(err.message) &&
    /Whitelisted File Extensions/.test(err.message) &&
    /not_whitelisted/.test(err.message));
  await assert.rejects(() =>
    downloadBlobIntoProfile({size:1}, 'Profil/média.WEBM'), err =>
      /Extension [.]webm non autorisée/.test(err.message) &&
      /Browser API/.test(err.message));
  assert.equal(completed.length, count, 'blocked extensions must not save unexpected files');
  sandbox.GM_info.downloadMode = 'native';
  await assert.rejects(() => saveMessage(msgVideo), /Browser API/);
  sandbox.GM_info.downloadMode = 'browser';

  folderStore.clear();
  // Emoji-only chat titles: real emoji, flags, keycaps, Telegram custom emoji
  // rendered without DOM text. The peer ID makes the folder deterministic.
  sandbox.GM_download = args => { completed.push(args); args.onload(); };
  browser.appImManager = {chat: {peerId:'-100123'}};
  const previousSelector = sandbox.document.querySelector;
  for (const label of ['🔥😈', '🇫🇷', '1️⃣', '❤️']) {
    assert.equal(containsReadableProfileText(label), false, label);
    sandbox.document.querySelector = () => ({textContent:label});
    assert.equal(currentChatLabel(), 'Profil_-100123', label);
    assert.equal(fileName(msgVideo, getMediaInfo(msgVideo)),
      'Profil_-100123 - 2026-10-12_10-21-04 - x.mp4');
    await saveMessage(msgVideo);
    assert.equal(completed.at(-1).name,
      'Profil_-100123/Profil_-100123 - 2026-10-12_10-21-04 - x.mp4');
  }
  // Chat titles using image-based custom emojis can have no textContent.
  sandbox.document.querySelector = () => ({textContent:''});
  assert.equal(currentChatLabel(), 'Profil_-100123');
  // Human-readable titles keep the original folder convention.
  sandbox.document.querySelector = () => ({textContent:'Canal café 🔥'});
  assert.equal(currentChatLabel(), 'Canal café 🔥');
  // An emoji-only ORIGINAL filename also gets a safe, stable fallback.
  assert.equal(fileName({
    mid:50, date, media:{document:{_: 'document',mime_type:'video/mp4',file_name:'🔥😈.mp4'}}
  }, getMediaInfo({media:{document:{_: 'document',mime_type:'video/mp4',file_name:'🔥😈.mp4'}}})),
  'Canal café 🔥 - 2026-10-12_10-21-04 - video_50.mp4');
  sandbox.document.querySelector = previousSelector;

  // USERNAME precedence from Telegram WebK appPeersManager, never title DOM.
  let username = 'real_username';
  browser.appImManager.chat.managers = {appPeersManager: {
    getPeerUsername(id) {
      assert.equal(String(id), String(browser.appImManager.chat.peerId));
      return username;
    }
  }};
  folderStore.clear();
  sandbox.document.querySelector = () => ({textContent:'🔥😈'});
  assert.equal(await readPeerUsername('-100123'), 'real_username');
  assert.equal(await resolveProfileFolder('-100123'), 'real_username');
  assert.equal(knownProfileFolder('-100123'), 'real_username');
  await saveMessage(msgVideo);
  assert.equal(completed.at(-1).name,
    'real_username/real_username - 2026-10-12_10-21-04 - x.mp4');

  // Sticky mapping survives changed public username and displayed title.
  username = 'changed_username';
  sandbox.document.querySelector = () => ({textContent:'Nouveau titre'});
  assert.equal(await resolveProfileFolder('-100123'), 'real_username');
  await saveMessage(msgVideo);
  assert.match(completed.at(-1).name, /^real_username\/real_username - /);

  // For an unseen user without username, use a readable title.
  folderStore.clear();
  username = '';
  assert.equal(await resolveProfileFolder('-100123'), 'Nouveau titre');
  folderStore.clear();
  sandbox.document.querySelector = () => ({textContent:'🔥😈'});
  assert.equal(await resolveProfileFolder('-100123'), 'Profil_-100123');

  // Protect the user's pre-existing v0.2.3 archive: success ledger implies
  // the folder still follows the legacy displayed title, not a new username.
  folderStore.clear();
  username = 'some_public_username';
  sandbox.document.querySelector = () => ({textContent:'Ancien dossier'});
  folderStore.set('JKL_TG_OK_V1:-100123:0', JSON.stringify(['-100123:26:doc']));
  assert.equal(await resolveProfileFolder('-100123'), 'Ancien dossier');
  assert.equal(folderStore.get('JKL_TG_FOLDER_V1:-100123'), 'Ancien dossier');
  folderStore.delete('JKL_TG_OK_V1:-100123:0');
  username = 'brand_new_username';
  assert.equal(await resolveProfileFolder('-100123'), 'Ancien dossier');

  sandbox.document.querySelector = previousSelector;
  console.log('OK: username-first, stable per-peer folders, emoji fallback and legacy archive pinning.');
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
    this.dataset = {};
  }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(key, cb) { this.listeners[key] = cb; }
  querySelector(selector) {
    if (!widgets.has(selector)) widgets.set(selector, new FakeElement());
    return widgets.get(selector);
  }
  set innerHTML(html) { this.html = html; }
  getBoundingClientRect() { return {left: parseFloat(this.style.left) || 400, top: parseFloat(this.style.top) || 76, width:210, height:40}; }
}
const documentEvents = new Map();
const storage = new Map();
const fakeDocument = {
  body: {appendChild(el) { appended = el; }},
  documentElement: {dataset: {}},
  createElement() { return new FakeElement(); },
  getElementById(id) { return appended?.id === id ? appended : null; },
  addEventListener(event, cb) { documentEvents.set(event, cb); },
  querySelector() { return null; },
  querySelectorAll() { return []; }
};
const fakeLocation = {hostname: 'web.telegram.org', pathname: '/a/', hash: '#abc', href: 'https://web.telegram.org/a/#abc'};
vm.runInNewContext(source, {
  window: {innerWidth:1440, innerHeight:900, addEventListener() {}},
  document: fakeDocument,
  localStorage: {getItem(k){return storage.get(k)||null;},setItem(k,v){storage.set(k,v);}},
  location: fakeLocation,
  navigator: {clipboard: {writeText: async () => {}}},
  MutationObserver: class {observe() {}},
  Element: FakeElement,
  console,
  setTimeout,
  clearTimeout,
  Promise,
  Date
}, {filename: filepath});
assert.equal(appended?.id, 'jkl-tg-dock');
assert.match(appended.html, /Télécharger le média survolé/);
assert.match(appended.html, /Copier rapport du backup/);
assert.equal(fakeDocument.documentElement.dataset.jklTelegramBackup, '0.2.4');
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

// Hover must update a visible status without toggling the panel.
const hover = documentEvents.get('mouseover');
assert.equal(typeof hover, 'function');
const target = new FakeElement();
let itemMid = '101';
target.closest = selector => {
  if (selector.startsWith('.album-item')) {
    return {
      closest() {
        return { dataset: {mid:itemMid, peerId:'-10042'} };
      }
    };
  }
  return null;
};
hover({target});
assert.match(widgets.get('#jkl-tg-status').textContent, /Média ciblé : #101/);
itemMid = '102';
hover({target});
assert.match(widgets.get('#jkl-tg-status').textContent, /Média ciblé : #102/);
assert.equal(fakeDocument.documentElement.dataset.jklTelegramBackup, '0.2.4');

// Dragging the title moves the whole UI and saves the new location.
const panel = widgets.get('#jkl-tg-panel');
const wasHidden = panel.hidden;
toggle.listeners.pointerdown({button:0,pointerId:11,clientX:420,clientY:90});
toggle.listeners.pointermove({pointerId:11,clientX:470,clientY:140,preventDefault() {}});
toggle.listeners.pointerup({pointerId:11});
assert.match(appended.style.left, /px$/);
assert.match(appended.style.top, /px$/);
assert.equal(JSON.parse(storage.get('jkl-tg-backup-dock-position-v1')).x, parseFloat(appended.style.left));
toggle.listeners.click();
assert.equal(panel.hidden, wasHidden, 'drag must not toggle the panel');
toggle.listeners.click();
assert.notEqual(panel.hidden, wasHidden, 'normal click must still toggle the panel');
console.log('OK: live hover (album inclus), glisser-déposer, persistance et distinction clic/glissement.');
