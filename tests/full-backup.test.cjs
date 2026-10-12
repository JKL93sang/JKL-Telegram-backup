'use strict';
// Integration simulation of WebK history pagination + Tampermonkey file writing.
// Does not imply a browser end-to-end test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
let code = fs.readFileSync(__dirname + '/../JKL_Telegram_Backup.user.js', 'utf8');
assert.ok(code.trimEnd().endsWith('})();'));
const p = code.lastIndexOf('\n})();');
code = code.slice(0, p) +
  '\nwindow.__bulkTests = {backupAll, stopBackup, fetchMediaPage, mediaIdentity, getMediaInfo, getResult:()=>lastBulkResult, reportForOpenChat, statusForOpenChat, resetResult:()=>{lastBulkResult=null;}, indexLocalFolder, findExistingDiskFile, setFolder:f=>{localFolderIndex=f;}, clearFolder:()=>{localFolderIndex=null;} };' +
  code.slice(p);

const events = [];
const completed = [];
const items = new Map();
let title = 'Canal de test';
const photo = {mid: 30, date: 1791763200, peerId: '-10042', media: {
  photo: {_: 'photo', id:'p30', sizes:[{_: 'photoSize',type:'x',size:600}]}
}};
const video = {mid: 20, date: 1791763201, peerId: '-10042', media: {
  document: {_: 'document', id:'v20', size:600, mime_type:'video/mp4',
    attributes:[{_: 'documentAttributeFilename', file_name:'video-source.mp4'}]}
}};
const docImage = {mid: 10, date: 1791763202, peerId: '-10042', media: {
  document: {_: 'document', id:'d10', size:600, mime_type:'image/png',
    attributes:[{_: 'documentAttributeFilename', file_name:'image originale.png'}]}
}};
const pages = {
  inputMessagesFilterPhotoVideo: [[photo, video], [photo]],
  inputMessagesFilterDocument: [[docImage, video]]
};
const manager = {
  async getHistory(opts) {
    events.push({filter:opts.inputFilter?._, offset:opts.offsetId, limit:opts.limit});
    const list = pages[opts.inputFilter._];
    if (!list) throw Error('Unexpected filter');
    const batch = opts.offsetId ? list[1] : list[0];
    const messages = opts.inputFilter._ === 'inputMessagesFilterDocument'
      ? list[0] : batch;
    return {
      history:messages.map(m => m.mid),
      messages,
      count: opts.inputFilter._ === 'inputMessagesFilterPhotoVideo' ? 3 : 2,
      isEnd: {top: opts.inputFilter._ === 'inputMessagesFilterDocument' || !!opts.offsetId}
    };
  }
};
const chat = {peerId:'-10042', managers:{appMessagesManager:manager}};
const window = {
  appImManager: {chat},
  appDownloadManager: {downloadMedia: async (opts) => {
    assert.ok(opts.media && opts.media._);
    return {size:600, slice() {return this;}};
  }},
  innerWidth:1440, innerHeight:900, addEventListener() {}
};
class Node {
  constructor(tag='') {
    this.tag=tag; this.dataset={}; this.style={}; this.hidden=false;
  }
}
const document = {
  body: {appendChild(node) {items.set(node.id,node);}},
  documentElement:{dataset:{}},
  getElementById(id) {return id==='jkl-tg-dock' ? new Node('dock') : (items.get(id)||null);},
  createElement(tag) {return new Node(tag);},
  querySelector(selector) {
    return selector === '#column-center .chat-info .peer-title'
      ? {textContent:title} : null;
  },
  addEventListener() {},
  querySelectorAll() {return [];}
};
const storage = new Map();
const sandbox = {
  window, document, location:{hostname:'web.telegram.org', pathname:'/k/', href:'https://web.telegram.org/k/', hash:''},
  localStorage: {
    getItem(key){return storage.get(key)||null;},
    setItem(key,value){storage.set(key,value);}
  },
  GM_info:{downloadMode:'browser'},
  GM_download:args=>{completed.push(args); args.onload();},
  MutationObserver:class{observe(){}},
  Element:Node,
  Date,Promise,console,
  setTimeout:(f,ms)=>setTimeout(f, Math.min(5,ms)),
  clearTimeout
};
vm.runInNewContext(code,sandbox,{filename:'JKL_Telegram_Backup.user.js'});
const {backupAll,getResult,mediaIdentity,getMediaInfo,reportForOpenChat,statusForOpenChat,resetResult,indexLocalFolder,findExistingDiskFile,setFolder,clearFolder}=window.__bulkTests;
(async()=>{
  assert.equal(getMediaInfo(docImage).type,'PHOTO');
  assert.equal(mediaIdentity(video,getMediaInfo(video),{peerId:'-10042'}),'-10042:20:v20');
  await backupAll();
  const first=getResult();
  assert.equal(first.finished,2);
  assert.equal(first.complete,true);
  assert.equal(first.found,3);
  assert.equal(first.done,3);
  assert.equal(first.skipped,0);
  assert.equal(first.errors,0);
  assert.equal(statusForOpenChat().kind,'complete');
  assert.equal(statusForOpenChat().label,'Terminé · 3 médias');
  assert.match(storage.get('JKL_TG_STATE_V1:-10042:0'), /"kind":"complete"/);
  resetResult(); // new browser session reading saved state
  assert.equal(statusForOpenChat().label,'Terminé · 3 médias');
  assert.equal(completed.length,3);
  assert.match(completed[0].name,/Canal de test\/Canal de test - .+ - photo_30\.jpg$/);
  assert.match(completed[1].name,/Canal de test\/Canal de test - .+ - video-source\.mp4$/);
  assert.match(completed[2].name,/Canal de test\/Canal de test - .+ - image originale\.png$/);
  assert.equal(events[0].offset,0);
  assert.equal(events[1].offset,20);
  assert.equal(events[2].filter,'inputMessagesFilterDocument');
  const keys=[...storage.keys()].filter(s=>s.startsWith('JKL_TG_OK_V1:'));
  assert.equal(keys.length,1);
  assert.equal(JSON.parse(storage.get(keys[0])).length,3);
  await backupAll();
  const second=getResult();
  assert.equal(second.complete,true);
  assert.equal(second.skipped,3);
  assert.equal(second.done,0);
  assert.equal(completed.length,3,'rerun must not redownload stored successes');
  // A single failed download must be visible in the report with MID, type,
  // media size and exact reason. Only successful items enter the ledger.
  const normalDownload=sandbox.GM_download;
  storage.clear();
  sandbox.GM_download=args=>{
    if (args.name.includes('video-source.mp4')) args.onerror({error:'save_failed_test'});
    else normalDownload(args);
  };
  await backupAll();
  const withErrors=getResult();
  assert.equal(withErrors.errors,1);
  assert.equal(withErrors.complete,false);
  assert.equal(statusForOpenChat().kind,'warning');
  assert.equal(statusForOpenChat().label,'À compléter · 1 erreur');
  assert.equal(withErrors.failures.length,1);
  assert.equal(withErrors.failures[0].mid,'20');
  assert.equal(withErrors.failures[0].type,'VIDEO');
  assert.match(withErrors.failures[0].size,/Mio$/);
  assert.match(withErrors.failures[0].reason,/save_failed_test/);
  const persistedReport=storage.get('JKL_TG_REPORT_V1:-10042:0');
  assert.match(persistedReport,/save_failed_test/);
  assert.match(reportForOpenChat(),/#20.*VIDEO.*save_failed_test/);
  assert.equal(JSON.parse(storage.get('JKL_TG_OK_V1:-10042:0')).length,2);
  sandbox.GM_download=normalDownload;
  await backupAll();
  assert.equal(getResult().done,1);
  assert.equal(getResult().skipped,2);
  assert.equal(getResult().errors,0);
  assert.equal(getResult().complete,true);
  // Refuse to mark a scan complete if the cursor never progresses.
  const original=manager.getHistory;
  manager.getHistory=async()=>({
    history:[20],messages:[video],isEnd:{top:false},count:999
  });
  await backupAll();
  const stalled=getResult();
  assert.equal(stalled.complete,false);
  assert.match(stalled.detail,/Pagination bloquée/);
  manager.getHistory=original;
  // Switching chat during download fails closed, instead of saving into a wrong folder.
  sandbox.GM_download=args=> {
    completed.push(args);
    chat.peerId='-10099';
    args.onload();
  };
  storage.clear();
  chat.peerId='-10042';
  await backupAll();
  assert.equal(getResult().complete,false);
  assert.match(getResult().detail,/Conversation changée/);
  assert.equal(statusForOpenChat().kind,'ready',
    'switching away from failed chat must not display its status');
  chat.peerId='-10042';
  assert.equal(statusForOpenChat().kind,'incomplete');

  // End-to-end simulated full backup on an emoji-only chat title.
  // The parser must NOT reject the title or mix it with another profile.
  chat.peerId='-10042';
  sandbox.GM_download=normalDownload;
  storage.clear();
  title='🔥😈';
  const previousCount=completed.length;
  await backupAll();
  assert.equal(getResult().complete,true);
  assert.equal(getResult().done,3);
  assert.equal(getResult().ctx.profile,'Profil_-10042');
  assert.equal(completed.length,previousCount+3);
  for (const saved of completed.slice(previousCount)) {
    assert.match(saved.name,/^Profil_-10042\/Profil_-10042 - /);
  }
  // A custom-emoji title can produce an entirely empty DOM text node.
  title='';
  storage.clear();
  await backupAll();
  assert.equal(getResult().complete,true);
  assert.equal(getResult().ctx.profile,'Profil_-10042');

  // Full backup on a new peer: username must win over a readable channel title.
  // The choice is then pinned, even when the public @username changes.
  chat.peerId='-10042';
  title='Canal de test';
  let currentUsername='official_channel';
  chat.managers.appPeersManager={
    getPeerUsername(peer) {
      assert.equal(String(peer), '-10042');
      return currentUsername;
    }
  };
  storage.clear();
  const beforeUsername=completed.length;
  await backupAll();
  assert.equal(getResult().complete,true);
  assert.equal(getResult().ctx.profile,'official_channel');
  assert.equal(getResult().done,3);
  assert.ok(completed.slice(beforeUsername).every(x=>
    x.name.startsWith('official_channel/official_channel - ')));
  assert.equal(storage.get('JKL_TG_FOLDER_V1:-10042'),'official_channel');
  currentUsername='renamed_channel';
  title='Nouveau titre';
  await backupAll();
  assert.equal(getResult().complete,true);
  assert.equal(getResult().done,0);
  assert.equal(getResult().skipped,3);
  assert.equal(getResult().ctx.profile,'official_channel');


  // A user-selected local folder (Firefox webkitdirectory) is authoritative.
  // It can rescue files already on disk despite an erased browser manifest.
  storage.clear();
  currentUsername='official_channel';
  title='Canal de test';
  const savedSet=completed.slice(beforeUsername,beforeUsername+3);
  const files=savedSet.map(entry => ({
    name:entry.name.split('/').at(-1),
    webkitRelativePath:'official_channel/' + entry.name.split('/').at(-1),
    size:600
  }));
  const folder=indexLocalFolder(files,{peerId:'-10042',profile:'official_channel'});
  assert.equal(folder.relevant,3);
  setFolder(folder);
  const preexisting=completed.length;
  await backupAll();
  let diskResult=getResult();
  assert.equal(diskResult.done,0);
  assert.equal(diskResult.skipped,3);
  assert.equal(diskResult.diskFound,3);
  assert.equal(diskResult.missingFromDisk,0);
  assert.equal(diskResult.complete,true);
  assert.equal(completed.length,preexisting);
  assert.equal(JSON.parse(storage.get('JKL_TG_OK_V1:-10042:0')).length,3,
    'folder scan must rebuild lost success ledger');

  // The selected folder is authoritative if browser ledger falsely says
  // a previously downloaded video is still present after manual deletion.
  const videoName=savedSet.find(x=>x.name.endsWith('video-source.mp4')).name.split('/').at(-1);
  const missingVideoFiles=files.filter(x=>x.name!==videoName);
  const reduced=indexLocalFolder(missingVideoFiles,{peerId:'-10042',profile:'official_channel'});
  setFolder(reduced);
  const preRecovery=completed.length;
  await backupAll();
  diskResult=getResult();
  assert.equal(diskResult.complete,true);
  assert.equal(diskResult.done,1);
  assert.equal(diskResult.skipped,2);
  assert.equal(diskResult.diskFound,2);
  assert.equal(diskResult.missingFromDisk,1);
  assert.equal(completed.length,preRecovery+1);
  assert.match(completed.at(-1).name,/video-source\.mp4$/);
  await backupAll();
  assert.equal(getResult().done,0,
    'do not redownload a GM_download-confirmed success twice in same session');
  assert.equal(getResult().skipped,3);

  // Root Downloads folder containing other profiles should match ONLY
  // the current profile subdirectory (and only exact filenames).
  const parentFiles=files.map(x=>({
    ...x,webkitRelativePath:'Downloads/' + x.webkitRelativePath
  }));
  parentFiles.push({name:videoName,
    webkitRelativePath:'Downloads/AutreProfil/' + videoName,size:600});
  const parent=indexLocalFolder(parentFiles,{peerId:'-10042',profile:'official_channel'});
  assert.equal(parent.relevant,3);
  assert.equal(parent.totalFiles,4);
  assert.equal(findExistingDiskFile(parent, {peerId:'-10042',profile:'official_channel'},
    videoName,getMediaInfo(video)),true);
  assert.equal(findExistingDiskFile(parent,{peerId:'-10099',profile:'official_channel'},
    videoName,getMediaInfo(video)),false);
  assert.throws(()=>indexLocalFolder(
    [{name:'different.mp4',size:600,webkitRelativePath:'Other/wrong/different.mp4'}],
    {peerId:'-10042',profile:'official_channel'}),/ne contient pas le sous-dossier/);
  assert.throws(()=>indexLocalFolder([],{peerId:'-10042',profile:'official_channel'}),
    /aucun fichier/);

  // A matching document with a truncated/different byte length must
  // NOT count as already downloaded. Avoid blindly trusting filenames.
  const incorrect=files.map(x=>({
    ...x,size:x.name.endsWith('image originale.png') ? 1 : x.size
  }));
  setFolder(indexLocalFolder(incorrect,{peerId:'-10042',profile:'official_channel'}));
  const beforeMismatch=completed.length;
  await backupAll();
  assert.equal(getResult().done,1);
  assert.equal(getResult().diskFound,2);
  assert.equal(getResult().missingFromDisk,1);
  assert.equal(completed.length,beforeMismatch+1);
  // Two Telegram messages can have the SAME expected filename (same
  // original name and timestamp), yet only one physical file exists.
  // Do not count the lone file twice.
  storage.clear();
  currentUsername='official_channel';
  title='Canal de test';
  pages.inputMessagesFilterPhotoVideo[0]=[video,{...video,mid:21}];
  pages.inputMessagesFilterPhotoVideo[1]=[photo];
  setFolder(indexLocalFolder(files,{peerId:'-10042',profile:'official_channel'}));
  const beforeCollision=completed.length;
  await backupAll();
  assert.equal(getResult().found,4);
  assert.equal(getResult().diskFound,3);
  assert.equal(getResult().done,1);
  assert.equal(getResult().skipped,3);
  assert.equal(completed.length,beforeCollision+1);
  clearFolder();

  // A browser restart during an active download must NEVER claim completion.
  resetResult();
  storage.set('JKL_TG_STATE_V1:-10042:0',
    JSON.stringify({kind:'running',label:'En cours · 2/3'}));
  assert.equal(statusForOpenChat().kind,'incomplete');
  assert.equal(statusForOpenChat().label,'Interrompu · relancer');
  console.log('OK: full backup, persistent completion indicator, failure separation and resume.');
})().catch(err=>{console.error(err);process.exitCode=1;});
