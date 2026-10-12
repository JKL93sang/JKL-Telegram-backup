// ==UserScript==
// @name         JKL Telegram Backup
// @namespace    https://github.com/JKL93sang
// @version      0.2.6
// @description  Telegram WebK: telechargement unitaire ou selection multiple de photos/videos avec noms lisibles.
// @author       JKL
// @match        https://web.telegram.org/*
// @match        https://webz.telegram.org/*
// @match        https://webk.telegram.org/*
// @sandbox      raw
// @grant        unsafeWindow
// @grant        GM_download
// @grant        GM_info
// @run-at       document-idle
// @homepageURL  https://github.com/JKL93sang/JKL-Telegram-backup
// @supportURL   https://github.com/JKL93sang/JKL-Telegram-backup/issues
// @updateURL    https://raw.githubusercontent.com/JKL93sang/JKL-Telegram-backup/main/JKL_Telegram_Backup.user.js
// @downloadURL  https://raw.githubusercontent.com/JKL93sang/JKL-Telegram-backup/main/JKL_Telegram_Backup.user.js
// ==/UserScript==

/*
 * v0.2.6 - WebK only, no external services.
 * SOLO / selection: fetch original media Blob, GM_download into profile folder.
 * ALL: paginate the accessible history with Telegram's getHistory media filters.
 * Sequential queue, explicit stop, progress, persistent success ledger/resume.
 * No claim of completeness without history-end proof on every filter.
 * 512 MiB per-file memory guard. WebK internals can change at any time.
 * Full-channel runs must be validated in Firefox before relying on the archive.
 */
(() => {
  'use strict';

  const PREFIX = '[JKL TG Backup]';
  const GAP_MS = 550;
  // Blob downloads consume memory: never silently save unrenamed large files.
  const MAX_RENAMED_BYTES = 512 * 1024 * 1024;
  const HISTORY_PAGE_SIZE = 75;
  const HISTORY_PAGE_GAP_MS = 600;
  const HISTORY_FILTERS = [
    'inputMessagesFilterPhotoVideo', 'inputMessagesFilterDocument'
  ];
  let pending = null;
  let running = false;
  let toastTimer = null;
  let bulkJob = null;
  let renderBulkProgress = null;
  let lastBulkResult = null;
  // Explicitly selected by the user. In-memory metadata only; never
  // persisted as proof of local files across reloads.
  let localFolderIndex = null;

  const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  function sanitize(value, fallback = 'inconnu') {
    const safe = String(value ?? '')
      .normalize('NFKC')
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^[. _]+|[. _]+$/g, '')
      .slice(0, 64);
    const name = safe || fallback;
    return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? `_${name}` : name;
  }

  // Windows-safe filename component; preserve readable spaces and accents.
  function filePart(value, fallback = 'inconnu', maxLen = 110) {
    const cleaned = String(value ?? '')
      .normalize('NFKC')
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/[. ]+$/g, '')
      .replace(/^[. ]+/g, '')
      .slice(0, maxLen).trim();
    const result = cleaned || fallback;
    return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)
      ? '_' + result : result;
  }

  function dateStamp(seconds) {
    if (!Number.isFinite(Number(seconds)) || Number(seconds) <= 0) return 'date-inconnue';
    const d = new Date(Number(seconds) * 1000);
    if (!Number.isFinite(d.getTime())) return 'date-inconnue';
    const pad = v => String(v).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  }

  function getMediaInfo(msg) {
    if (!msg || !msg.media) return null;
    const photo = msg.media.photo;
    if (photo && photo._ === 'photo') return { media: photo, type: 'PHOTO', ext: 'jpg', originalName: null };

    const doc = msg.media.document;
    if (!doc || doc._ !== 'document') return null;
    const mime = String(doc.mime_type || '').toLowerCase();
    const attributes = Array.isArray(doc.attributes) ? doc.attributes : [];
    const orig = String(doc.file_name || attributes.find(a => a?._ === 'documentAttributeFilename')?.file_name || '');
    const isVideo = mime.startsWith('video/') || attributes.some(a => a?._ === 'documentAttributeVideo');
    const isGif = mime === 'image/gif';
    const isImage = mime.startsWith('image/') && !doc.sticker && !doc.pFlags?.sticker;
    if (!isVideo && !isGif && !isImage) return null;

    const extMatch = orig.match(/\.([a-z0-9]{2,6})$/i);
    const acceptable = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'gif', 'jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'bmp']);
    let ext = extMatch && acceptable.has(extMatch[1].toLowerCase()) ? extMatch[1].toLowerCase() : '';
    if (!ext) {
      ext = ({
        'image/gif': 'gif', 'image/png': 'png', 'image/jpeg': 'jpg',
        'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif',
        'image/bmp': 'bmp', 'video/webm': 'webm',
        'video/quicktime': 'mov', 'video/x-matroska': 'mkv'
      })[mime] || (isImage ? 'jpg' : 'mp4');
    }
    return { media: doc, type: isGif ? 'GIF' : isImage ? 'PHOTO' : 'VIDEO', ext, originalName: orig || null };
  }

  // Telegram WebK may render a chat title made solely of custom emojis as
  // image elements, leaving textContent empty. Emoji-only names can also
  // produce a fragile path for filesystem downloads.
  function containsReadableProfileText(value) {
    const remainder = String(value ?? '').normalize('NFKC')
      .replace(/[0-9#*]\uFE0F?\u20E3/gu, '') // keycap emojis
      .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}]/gu, '')
      .replace(/[\u200D\uFE0E\uFE0F\u20E3\u{E0020}-\u{E007F}]/gu, '');
    return /[\p{L}\p{N}]/u.test(remainder);
  }

  function safeProfileFallback(peerId) {
    const id = peerId ?? page.appImManager?.chat?.peerId;
    if (id == null || id === '') return 'Telegram';
    const safeId = String(id).replace(/[^0-9A-Za-z_-]/g, '_').slice(0, 64);
    return safeId ? 'Profil_' + safeId : 'Telegram';
  }

  function currentChatLabel(peerId) {
    const selectors = [
      '#column-center .chat-info .peer-title',
      '#column-center .chat-info .title',
      '#column-center .person .peer-title',
      '#column-center .peer-title'
    ];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      const label = el?.textContent?.trim();
      if (label && containsReadableProfileText(label)) {
        return filePart(label, safeProfileFallback(peerId), 70);
      }
    }
    // Never use a shared generic directory for different emoji-only chats.
    return safeProfileFallback(peerId);
  }


  // A peer's folder is sticky across username/title changes. The mapping is
  // keyed by Telegram's stable peer ID, not by a mutable public @username.
  const FOLDER_KEY_PREFIX = 'JKL_TG_FOLDER_V1:';

  function profileFolderKey(peerId) {
    return FOLDER_KEY_PREFIX + String(peerId);
  }

  function knownProfileFolder(peerId) {
    if (peerId === undefined || peerId === null || peerId === '') return null;
    const saved = localStorage.getItem(profileFolderKey(peerId));
    if (!saved) return null;
    // Only simple folder components produced by filePart are accepted.
    if (saved === '.' || saved === '..' || saved.includes('/') ||
        saved.includes('\\') || !saved.trim() || saved === 'Telegram') {
      throw new Error('Dossier mémorisé invalide pour le profil ' + String(peerId) +
        '. Sauvegarde arrêtée pour éviter un mélange de dossiers.');
    }
    return filePart(saved, safeProfileFallback(peerId), 70);
  }

  function legacyHasSuccessfulBackup(peerId, threadId) {
    const keys = [
      'JKL_TG_OK_V1:' + String(peerId) + ':' + String(threadId || 0),
      'JKL_TG_OK_V1:' + String(peerId) + ':0'
    ];
    for (const key of keys) {
      const record = localStorage.getItem(key);
      if (!record) continue;
      const parsed = JSON.parse(record);
      if (Array.isArray(parsed) && parsed.length) return true;
    }
    return false;
  }

  async function readPeerUsername(peerId) {
    const chat = page.appImManager?.chat;
    const managers = chat?.managers || page.appImManager?.managers;
    const getUsername = managers?.appPeersManager?.getPeerUsername;
    if (typeof getUsername !== 'function') return '';
    // This is WebK's own API for the active public username. Never scrape
    // a Telegram URL or extract a username from a message sender.
    let username;
    try {
      // Hovered message DOM data-peer-id is a string; WebK managers expect
      // their native PeerId (number with WebK prototype helpers). If this
      // media belongs to the open chat, always use the actual chat PeerId.
      const nativePeerId = chat?.peerId != null &&
        String(chat.peerId) === String(peerId) ? chat.peerId : peerId;
      username = await getUsername.call(managers.appPeersManager, nativePeerId);
    } catch (err) {
      console.warn(PREFIX, 'Pseudo Telegram indisponible, nom affiché utilisé', err);
      return '';
    }
    const value = String(username || '').replace(/^@/, '').trim();
    return /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : '';
  }

  // Different peers must not reuse a folder already pinned to another peer.
  // Particularly important if an old @username gets reassigned.
  function folderClaimedByAnotherPeer(folder, peerId) {
    const count = Number(localStorage.length) || 0;
    for (let i = 0; i < count; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(FOLDER_KEY_PREFIX) || key === profileFolderKey(peerId)) {
        continue;
      }
      const other = localStorage.getItem(key);
      if (typeof other === 'string' && other.toLowerCase() === folder.toLowerCase()) {
        return true;
      }
    }
    return false;
  }

  async function resolveProfileFolder(peerId, threadId) {
    const currentPeerId = peerId ?? page.appImManager?.chat?.peerId;
    if (currentPeerId === undefined || currentPeerId === null || currentPeerId === '') {
      throw new Error('Identifiant Telegram indisponible : dossier de profil non déterminé.');
    }
    const saved = knownProfileFolder(currentPeerId);
    if (saved) return saved;

    // v0.2.3 saved files under the visible title, or Profil_<peerId>
    // for emoji-only titles. There was no folder registry at that time.
    // If a success ledger already exists, pin the legacy naming convention
    // before introducing username-first for NEW profiles.
    const legacy = legacyHasSuccessfulBackup(currentPeerId, threadId);
    const username = legacy ? '' : await readPeerUsername(currentPeerId);
    const candidate = legacy
      ? currentChatLabel(currentPeerId)
      : username || currentChatLabel(currentPeerId);
    let name = filePart(candidate, safeProfileFallback(currentPeerId), 70);
    if (name === 'Telegram') {
      throw new Error('Dossier de profil non déterminé : nom et identifiant indisponibles.');
    }

    // Never merge two identities just because one username is reassigned or
    // two private chats share a display title. Preserve the first owner's folder.
    if (folderClaimedByAnotherPeer(name, currentPeerId)) {
      const suffix = '_' + String(currentPeerId).replace(/[^0-9A-Za-z_-]/g, '_');
      const prefix = name.slice(0, Math.max(1, 70 - suffix.length));
      name = filePart(prefix + suffix, safeProfileFallback(currentPeerId), 70);
      if (folderClaimedByAnotherPeer(name, currentPeerId)) {
        throw new Error('Collision de dossiers Telegram : sauvegarde interrompue.');
      }
    }
    // The registry cannot be used to infer/rename an existing filesystem
    // folder. A write failure must be explicit, not silently split archives.
    localStorage.setItem(profileFolderKey(currentPeerId), name);
    return name;
  }

  function fileName(msg, mediaInfo, profile = currentChatLabel(msg?.peerId)) {
    const mid = msg.mid ?? msg.id;
    if (mid === undefined || mid === null || mid === '') throw new Error('ID de message indisponible.');
    const source = filePart(profile, 'Telegram', 70);
    const extension = mediaInfo.ext;
    let originalBase;
    if (mediaInfo.originalName) {
      // Telegram can provide the original file name for videos/documents.
      // Reject directory prefixes and dangerous/nonmedia extensions.
      const basename = String(mediaInfo.originalName).split(/[\\/]/).pop();
      const recognized = /\.([a-z0-9]{2,6})$/i.exec(basename || '');
      const baseWithoutExt = recognized ? basename.slice(0, -recognized[0].length) : basename;
      const fallback = mediaInfo.type.toLowerCase() + '_' + mid;
      // Emoji-only original names may be rejected as paths too.
      originalBase = containsReadableProfileText(baseWithoutExt)
        ? filePart(baseWithoutExt, fallback, 120)
        : fallback;
    } else {
      // Regular Telegram photos do not normally expose their original name.
      originalBase = filePart(mediaInfo.type.toLowerCase() + '_' + mid);
    }
    const result = `${source} - ${dateStamp(msg.date)} - ${originalBase}.${extension}`;
    return result;
  }


  // The browser's HTML <a download> treats slashes as filename characters.
  // Tampermonkey Browser API accepts relative directories in GM_download.name.
  function profileDownloadPath(profile, name) {
    return filePart(profile, 'Telegram', 70) + '/' + String(name);
  }

  function gmDownloadMode() {
    return typeof GM_info !== 'undefined' ? String(GM_info?.downloadMode || '') : '';
  }

  function downloadBlobIntoProfile(blob, path) {
    if (typeof GM_download !== 'function') {
      return Promise.reject(new Error('GM_download indisponible : impossible de créer le dossier.'));
    }
    const mode = gmDownloadMode().toLowerCase();
    if (mode === 'native' || mode === 'disabled') {
      return Promise.reject(new Error(
        'Dossier indisponible : Tampermonkey → Paramètres → Téléchargements → Browser API.'
      ));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const complete = error => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
      try {
        GM_download({
          url: blob,
          name: path,
          saveAs: false,
          conflictAction: 'uniquify',
          onload: () => complete(),
          onerror: event => {
            const code = String(event?.error || 'inconnu');
            if (code === 'not_whitelisted') {
              // The browser download whitelist is a user permission. Never
              // bypass it or silently fall back to an unclassified file.
              const extension = String(path).split('/').pop()
                ?.match(/[.]([a-z0-9]{2,8})$/i)?.[1]?.toLowerCase();
              complete(new Error(
                'Extension ' + (extension ? '.' + extension : 'du fichier') +
                ' non autorisée (not_whitelisted). Tampermonkey → Paramètres → ' +
                'Téléchargements → Whitelisted File Extensions : ajouter ' +
                (extension || 'cette extension') +
                ' aux extensions existantes. Garder le mode Browser API.'
              ));
              return;
            }
            complete(new Error(
              'Téléchargement dans le dossier échoué (' +
              String(event?.error || event?.details || 'inconnu') +
              '). Vérifie les permissions et le mode Browser API de Tampermonkey.'
            ));
          },
          ontimeout: () => complete(new Error('Téléchargement Tampermonkey expiré.'))
        });
      } catch (error) {
        complete(new Error('Tampermonkey a refusé la sauvegarde : ' +
          (error?.message || String(error))));
      }
    });
  }

  function toast(text, isError = false) {
    let element = document.getElementById('jkl-tg-toast');
    if (!element) {
      element = document.createElement('div');
      element.id = 'jkl-tg-toast';
      element.style.cssText = [
        'position:fixed', 'left:50%', 'bottom:24px', 'transform:translateX(-50%)',
        'z-index:2147483646', 'border-radius:10px', 'padding:10px 14px',
        'box-shadow:0 4px 24px #0004', 'max-width:min(90vw,560px)',
        'font:13px/1.35 system-ui,sans-serif', 'pointer-events:none',
        'color:#fff', 'text-align:center'
      ].join(';');
      document.body.appendChild(element);
    }
    element.style.background = isError ? '#a73535' : '#243849';
    element.textContent = text;
    element.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { element.hidden = true; }, isError ? 5500 : 2700);
  }

  function getMessage(peerId, mid) {
    const lookup = page.mtprotoMessagePort?.getMessageByPeer;
    if (typeof lookup !== 'function') throw new Error('Acces aux messages WebK indisponible.');
    const msg = lookup.call(page.mtprotoMessagePort, peerId, Number(mid));
    if (!msg || typeof msg.then === 'function') throw new Error('Message non charge en memoire.');
    return msg;
  }


  function largestPhotoSize(photo) {
    const sizes = Array.isArray(photo.sizes) ? photo.sizes : [];
    const valid = sizes.filter(size => size && size._ !== 'photoSizeEmpty');
    return valid.length ? valid[valid.length - 1] : null;
  }

  async function saveMessage(msg, peerId, profileOverride) {
    const info = getMediaInfo(msg);
    if (!info) return { skipped: true };

    const downloader = page.appDownloadManager?.downloadMedia;
    if (typeof downloader !== 'function') {
      throw new Error('Moteur Blob Telegram WebK indisponible. Aucun fichier enregistré.');
    }
    if (typeof GM_download !== 'function') {
      throw new Error('GM_download indisponible : vérifie les permissions de Tampermonkey.');
    }
    const mode = gmDownloadMode().toLowerCase();
    if (mode === 'native' || mode === 'disabled') {
      throw new Error('Pour créer les dossiers : Tampermonkey → Téléchargements → Browser API.');
    }
    const profile = profileOverride || await resolveProfileFolder(peerId ?? msg.peerId);
    const name = fileName(msg, info, profile);
    const path = profileDownloadPath(profile, name);
    const photoSize = info.media._ === 'photo' ? largestPhotoSize(info.media) : null;
    if (info.media._ === 'photo' && !photoSize) {
      throw new Error('Taille de photo Telegram indisponible.');
    }
    const expectedSize = info.media._ === 'document'
      ? Number(info.media.size)
      : Number(photoSize?.size);
    if (Number.isFinite(expectedSize) && expectedSize > MAX_RENAMED_BYTES) {
      throw new Error('Média supérieur à 512 Mio : sauvegarde renommée bloquée pour préserver la mémoire.');
    }

    // In WebK, downloadToDisc's streaming Service Worker uses the internal
    // document filename, ignoring our filename option. For renaming, fetch
    // the Blob then trigger <a download="custom-name"> instead.
    const request = { media: info.media };
    if (photoSize) request.thumb = photoSize;
    const blob = await downloader.call(page.appDownloadManager, request);
    if (!blob || typeof blob.size !== 'number' || typeof blob.slice !== 'function') {
      throw new Error('Telegram a renvoyé un contenu invalide : fichier non enregistré.');
    }
    if (blob.size > MAX_RENAMED_BYTES) {
      throw new Error('Média téléchargé supérieur à 512 Mio : sauvegarde annulée.');
    }
    if (info.media._ === 'document' && Number.isFinite(expectedSize) &&
      expectedSize > 0 && blob.size !== expectedSize) {
      throw new Error('Taille vidéo incohérente (' + blob.size + '/' + expectedSize +
        ' octets) : sauvegarde annulée.');
    }

    // GM_download accepts Blob objects on current Tampermonkey releases.
    // Its Browser API mode honors relative subdirectories; the HTML anchor
    // approach cannot create folders.
    await downloadBlobIntoProfile(blob, path);
    console.info(PREFIX, 'Fichier transmis à Tampermonkey :', path, blob.size, 'octets');
    return { skipped: false, name, path, profile, size: blob.size };
  }

  async function saveSingle(ref) {
    if (running) return toast('Un telechargement JKL est deja en cours.');
    running = true;
    try {
      const msg = getMessage(ref.peerId, ref.mid);
      const result = await saveMessage(msg, ref.peerId);
      if (result.skipped) throw new Error('Ce message ne contient pas une photo ou une video prise en charge.');
      toast(`JKL : téléchargement terminé → ${result.path}`);
      console.info(PREFIX, 'Chemin demandé à Tampermonkey :', result.path);
    } catch (err) {
      toast(`Echec : ${err.message || String(err)}`, true);
      console.error(PREFIX, err);
    } finally {
      running = false;
    }
  }

  async function saveSelection(button) {
    if (running) return toast('Un telechargement JKL est deja en cours.');
    const selection = page.appImManager?.chat?.selection;
    if (!selection || typeof selection.getSelectedMessages !== 'function') {
      toast('Selection Telegram WebK indisponible.', true);
      return;
    }
    running = true;
    button.disabled = true;
    const originalLabel = button.textContent;
    let done = 0, errors = 0, skipped = 0;
    try {
      const msgs = await selection.getSelectedMessages();
      const candidates = Array.isArray(msgs) ? msgs.filter(m => getMediaInfo(m)) : [];
      if (!candidates.length) {
        toast('Aucune photo ou video dans les messages selectionnes.', true);
        return;
      }
      for (let i = 0; i < candidates.length; i++) {
        button.textContent = `JKL ${i + 1}/${candidates.length}`;
        try {
          const result = await saveMessage(candidates[i]);
          if (result.skipped) skipped++;
          else done++;
        } catch (err) {
          errors++;
          console.error(PREFIX, 'Message en echec:', candidates[i]?.mid, err);
        }
        if (i + 1 < candidates.length) await delay(GAP_MS);
      }
      toast(`Selection traitee : ${done} demandes, ${errors} erreurs${skipped ? `, ${skipped} ignores` : ''}.`, errors > 0);
    } catch (err) {
      toast(`Impossible de lire la selection : ${err.message || err}`, true);
      console.error(PREFIX, err);
    } finally {
      running = false;
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }


  async function bulkContext() {
    if (!isWebK()) throw new Error('Backup complet : ouvre Telegram WebK (/k/).');
    const chat = page.appImManager?.chat;
    const peerId = chat?.peerId;
    if (peerId === undefined || peerId === null || peerId === '') {
      throw new Error('Aucune conversation Telegram ouverte.');
    }
    const manager = chat?.managers?.appMessagesManager ||
      page.appImManager?.managers?.appMessagesManager;
    if (typeof manager?.getHistory !== 'function') {
      throw new Error('API historique WebK indisponible : aucun scan lancé.');
    }
    if (typeof page.appDownloadManager?.downloadMedia !== 'function' ||
        typeof GM_download !== 'function' || gmDownloadMode().toLowerCase() !== 'browser') {
      throw new Error('Pour télécharger : moteur Blob + Tampermonkey Browser API requis.');
    }
    // A forum thread has its own search context, unlike the channel's main feed.
    const threadId = Number(chat.threadId) || undefined;
    // The resolved folder stays stable across title/username changes and
    // is shared by SOLO and full backup for this peer.
    const profile = await resolveProfileFolder(peerId, threadId);
    return { peerId, threadId, profile, manager };
  }


  function normalizedDiskName(value) {
    return String(value ?? '').normalize('NFKC').toLowerCase();
  }

  // The directory picker exposes file names, lengths and relative paths,
  // without granting arbitrary filesystem read or write access.
  // Select EITHER the current profile folder (Profile/file.jpg) OR its
  // immediate parent (Downloads/Profile/file.jpg). Ignore unrelated peers.
  function indexLocalFolder(files, ctx) {
    if (!ctx || ctx.peerId == null || !ctx.profile) {
      throw new Error('Conversation Telegram non identifiée pour le dossier.');
    }
    const selected = Array.from(files || []);
    if (!selected.length) {
      throw new Error('Le dossier sélectionné ne contient aucun fichier lisible.');
    }
    const firstParts = String(selected[0].webkitRelativePath || '')
      .replace(/\\/g, '/').split('/');
    const root = firstParts[0];
    if (!root || firstParts.length < 2) {
      throw new Error('Choisis un dossier entier, pas seulement des fichiers.');
    }
    const ownRoot = normalizedDiskName(root) === normalizedDiskName(ctx.profile);
    const index = new Map();
    let relevant = 0, relatedFolder = ownRoot;
    for (const file of selected) {
      const parts = String(file?.webkitRelativePath || '')
        .replace(/\\/g, '/').split('/');
      if (parts[0] !== root) continue;
      let filename = null;
      if (ownRoot && parts.length === 2) {
        filename = parts[1];
      } else if (!ownRoot && parts.length === 3 &&
          normalizedDiskName(parts[1]) === normalizedDiskName(ctx.profile)) {
        relatedFolder = true;
        filename = parts[2];
      }
      if (!filename || filename === '.' || filename === '..') continue;
      const size = Number(file.size);
      if (!Number.isFinite(size) || size <= 0) continue;
      index.set(normalizedDiskName(filename), size);
      relevant++;
    }
    if (!relatedFolder) {
      throw new Error('Le dossier choisi ne contient pas le sous-dossier "' +
        ctx.profile + '". Choisis ce dossier directement ou son dossier parent.');
    }
    return {
      ctx:{peerId:ctx.peerId, threadId:ctx.threadId},
      profile:ctx.profile,
      root,
      ownRoot,
      index,
      totalFiles:selected.length,
      relevant,
      sessionDownloaded:new Set()
    };
  }

  function findExistingDiskFile(folder, ctx, name, info) {
    if (!folder || !sameBackupChat(folder.ctx, ctx) ||
        folder.profile !== ctx.profile) return false;
    const actual = folder.index.get(normalizedDiskName(name));
    if (!Number.isFinite(actual) || actual <= 0) return false;
    // Telegram document byte lengths are reliable; reject truncated matches.
    // Photo-size metadata can describe a rendition; require nonzero for photos.
    if (info.media?._ === 'document') {
      const declared = Number(info.media.size);
      if (Number.isFinite(declared) && declared > 0 && actual !== declared) {
        return false;
      }
    }
    return true;
  }

  function selectedFolderFor(ctx) {
    return localFolderIndex &&
      sameBackupChat(localFolderIndex.ctx, ctx) &&
      localFolderIndex.profile === ctx.profile ? localFolderIndex : null;
  }

  function folderSelectionStatus(ctx) {
    const folder = selectedFolderFor(ctx);
    return folder
      ? 'Dossier contrôlé : ' + folder.root +
        ' · ' + folder.relevant + ' fichier(s) du profil'
      : 'Dossier local : non sélectionné (reprise par historique uniquement).';
  }

  function ledgerKey(ctx) {
    return 'JKL_TG_OK_V1:' + String(ctx.peerId) + ':' + String(ctx.threadId || 0);
  }

  function loadLedger(ctx) {
    const stored = localStorage.getItem(ledgerKey(ctx));
    if (!stored) return new Set();
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed) || parsed.some(x => typeof x !== 'string')) {
      throw new Error('Historique anti-doublons invalide. Aucun téléchargement lancé.');
    }
    return new Set(parsed);
  }

  function mediaIdentity(msg, info, ctx) {
    const peer = msg.peerId ?? ctx.peerId;
    const mid = msg.mid ?? msg.id;
    return String(peer) + ':' + String(mid) + ':' +
      String(info.media.id ?? info.media.access_hash ?? '');
  }

  function saveLedger(ctx, ledger) {
    // Keep the in-memory ledger even if browser storage reaches its quota, but
    // report failure so we never promise safe resume across browser restarts.
    try {
      localStorage.setItem(ledgerKey(ctx), JSON.stringify([...ledger]));
      return true;
    } catch (err) {
      console.warn(PREFIX, 'Manifeste anti-doublons non persisté', err);
      return false;
    }
  }

  function assertCurrentChat(ctx) {
    const current = page.appImManager?.chat;
    if (String(current?.peerId) !== String(ctx.peerId) ||
        Number(current?.threadId || 0) !== Number(ctx.threadId || 0)) {
      throw new Error('Conversation changée : backup interrompu pour éviter les mélanges.');
    }
  }

  // The WebK shared-media view uses this exact getHistory cursor/filter contract.
  // top=true is the ONLY evidence we have reached the oldest available message.
  async function fetchMediaPage(ctx, filter, cursor) {
    const options = {
      peerId: ctx.peerId,
      threadId: ctx.threadId,
      inputFilter: {_: filter},
      offsetId: cursor?.mid || 0,
      offsetPeerId: cursor?.peerId || undefined,
      limit: HISTORY_PAGE_SIZE
    };
    const result = await ctx.manager.getHistory(options);
    if (!result || !Array.isArray(result.history)) {
      throw new Error('Page historique invalide (filtre ' + filter + ').');
    }
    const messages = Array.isArray(result.messages) ? result.messages.filter(Boolean) : [];
    if (messages.length !== result.history.length) {
      const lookup = page.mtprotoMessagePort?.getMessageByPeer;
      if (typeof lookup === 'function') {
        const found = new Set(messages.map(msg => String(msg.peerId) + ':' + String(msg.mid)));
        for (const mid of result.history) {
          const key = String(ctx.peerId) + ':' + String(mid);
          if (found.has(key)) continue;
          const message = await lookup.call(page.mtprotoMessagePort, ctx.peerId, Number(mid));
          if (message && typeof message === 'object' && message.mid != null) {
            messages.push(message);
          }
        }
      }
    }
    const rawLast = result.history.length ? result.history[result.history.length - 1] : null;
    // Use the backend page cursor, not a potentially re-ordered hydrated array.
    const matched = rawLast == null ? null :
      messages.find(message => String(message.mid) === String(rawLast));
    const next = rawLast == null ? null :
      {peerId: matched?.peerId ?? ctx.peerId, mid: rawLast};
    return { messages, next, rawCount: result.history.length,
      isTopEnd: result.isEnd?.top === true,
      expected: Number.isFinite(result.count) ? result.count : null };
  }


  function reportKey(ctx) {
    return 'JKL_TG_REPORT_V1:' + String(ctx.peerId) + ':' + String(ctx.threadId || 0);
  }

  function currentReportContext() {
    const chat = page.appImManager?.chat;
    if (chat?.peerId == null) return null;
    return {peerId:chat.peerId, threadId:Number(chat.threadId) || undefined};
  }

  function failureDescription(msg, info, error) {
    const mid = String(msg.mid ?? msg.id ?? 'inconnu');
    const rawSize = info.media?._ === 'photo'
      ? largestPhotoSize(info.media)?.size : info.media?.size;
    const size = Number(rawSize);
    const formattedSize = rawSize != null && Number.isFinite(size)
      ? (size / 1048576).toFixed(2) + ' Mio' : 'taille inconnue';
    const reason = String(error?.message || error || 'Erreur inconnue')
      .replace(/\s+/g, ' ').slice(0, 320);
    return {mid, type:info.type || 'MEDIA', size:formattedSize, reason};
  }

  function saveLastReport(job) {
    try {
      localStorage.setItem(reportKey(job.ctx), bulkText(job));
    } catch (error) {
      console.warn(PREFIX, 'Rapport du backup non persisté', error);
    }
  }

  function reportForOpenChat() {
    const ctx = currentReportContext();
    if (!ctx) return '';
    const matches = job => job &&
      String(job.ctx?.peerId) === String(ctx.peerId) &&
      Number(job.ctx?.threadId || 0) === Number(ctx.threadId || 0);
    if (matches(bulkJob)) return bulkText(bulkJob);
    if (matches(lastBulkResult)) return bulkText(lastBulkResult);
    try {
      return localStorage.getItem(reportKey(ctx)) || '';
    } catch { return ''; }
  }


  // A small, explicit per-conversation state for the always-visible launcher.
  // Unlike the successful-file ledger, this reflects the result of a *scan*.
  function statusKey(ctx) {
    return 'JKL_TG_STATE_V1:' + String(ctx.peerId) + ':' +
      String(ctx.threadId || 0);
  }

  function sameBackupChat(ctx, other) {
    return !!ctx && !!other &&
      String(ctx.peerId) === String(other.peerId) &&
      Number(ctx.threadId || 0) === Number(other.threadId || 0);
  }

  function statusFromJob(job, active = false) {
    if (active) {
      if (job.cancelled) return {kind:'stopping', label:'Arrêt demandé…'};
      return {kind:'running',
        label:'En cours · ' + (job.done + job.skipped) + '/' + job.found};
    }
    if (job.complete) {
      return {kind:'complete', label:'Terminé · ' + job.found +
        ' média' + (job.found === 1 ? '' : 's')};
    }
    if (job.cancelled) return {kind:'stopped', label:'Arrêté · reprise possible'};
    if (job.errors) return {kind:'warning',
      label:'À compléter · ' + job.errors +
        ' erreur' + (job.errors === 1 ? '' : 's')};
    return {kind:'incomplete', label:'Incomplet · voir rapport'};
  }

  function persistBackupState(job, active = false) {
    try {
      localStorage.setItem(statusKey(job.ctx),
        JSON.stringify(statusFromJob(job, active)));
    } catch (error) {
      console.warn(PREFIX, 'État visuel du backup non enregistré', error);
    }
  }

  function statusForOpenChat() {
    const ctx = currentReportContext();
    if (!ctx) return {kind:'ready', label:'Prêt'};
    if (sameBackupChat(bulkJob?.ctx, ctx)) {
      return statusFromJob(bulkJob, true);
    }
    if (sameBackupChat(lastBulkResult?.ctx, ctx)) {
      return statusFromJob(lastBulkResult);
    }
    try {
      const saved = JSON.parse(localStorage.getItem(statusKey(ctx)) || 'null');
      if (saved && typeof saved.label === 'string' &&
          ['complete', 'warning', 'stopped', 'incomplete'].includes(saved.kind)) {
        return {kind:saved.kind, label:saved.label.slice(0, 100)};
      }
      // A refresh or browser crash in the middle of a run is NOT a success.
      if (saved?.kind === 'running' || saved?.kind === 'stopping') {
        return {kind:'incomplete', label:'Interrompu · relancer'};
      }
    } catch (error) {
      console.warn(PREFIX, 'Dernier état visuel invalide', error);
    }
    return {kind:'ready', label:'Prêt'};
  }

  function bulkText(job) {
    return [
      job.stage,
      'Conversation : ' + job.ctx.profile,
      'Pages lues : ' + job.pages,
      'Médias trouvés : ' + job.found,
      'Enregistrés : ' + job.done + ' | Déjà faits : ' + job.skipped,
      'Erreurs : ' + job.errors + ' | Filtres terminés : ' + job.finished + '/' + HISTORY_FILTERS.length,
      ...(job.folder ? [
        'Sur disque : ' + job.diskFound +
          ' | Absents malgré historique : ' + job.missingFromDisk,
        'Dossier vérifié : ' + job.folder.root + ' (' +
          job.folder.relevant + ' fichier(s) indexés pour ce profil)'
      ] : []),
      job.detail || '',
      ...(job.failures?.length ? [
        'Détail des échecs :',
        ...job.failures.map((item, index) =>
          (index + 1) + '. #' + item.mid + ' · ' + item.type +
          ' · ' + item.size + ' · ' + item.reason),
        ...(job.errors > job.failures.length
          ? ['… ' + (job.errors - job.failures.length) + ' erreurs supplémentaires (voir F12).']
          : [])
      ] : [])
    ].filter(Boolean).join('\n');
  }

  function bulkStatus(job) {
    job && renderBulkProgress?.(job);
  }

  async function backupAll() {
    if (running || bulkJob) return toast('Un téléchargement JKL est déjà en cours.', true);
    let ctx;
    let ledger;
    try {
      ctx = await bulkContext();
      ledger = loadLedger(ctx);
    } catch (err) {
      toast('Backup complet : ' + (err.message || err), true);
      return;
    }
    lastBulkResult = null;
    const folder = selectedFolderFor(ctx);
    const job = bulkJob = {
      ctx, cancelled:false, stage:'Préparation du scan…', detail:'',
      pages:0, found:0, done:0, skipped:0, errors:0,
      finished:0, seen:new Set(), ledger, ledgerSafe:true, complete:false,
      diskFound:0, missingFromDisk:0, folder, failures: []
    };
    running = true;
    persistBackupState(job, true);
    bulkStatus(job);
    try {
      // Two searches are intentional: PhotoVideo for media and Document for
      // images/videos sent as original files, plus GIFs, with ID deduplication.
      for (const filter of HISTORY_FILTERS) {
        if (job.cancelled) break;
        let cursor = null, failures = 0, endReached = false;
        for (let n = 0; n < 20000; n++) {
          if (job.cancelled) break;
          assertCurrentChat(ctx);
          job.stage = filter === HISTORY_FILTERS[0]
            ? 'Scan + téléchargement · photos / vidéos'
            : 'Scan + téléchargement · fichiers médias / GIF';
          job.detail = 'Page ' + (n + 1) + ' du filtre actuel…';
          bulkStatus(job);

          let pageData;
          try {
            pageData = await fetchMediaPage(ctx, filter, cursor);
          } catch (err) {
            throw new Error('Historique inaccessible : ' + (err.message || err));
          }
          job.pages++;
          if (pageData.expected != null) {
            job.detail = 'Messages correspondant au filtre : ' + pageData.expected;
          }
          if (pageData.rawCount !== pageData.messages.length) {
            throw new Error('Page Telegram partiellement hydratée (' +
              pageData.messages.length + '/' + pageData.rawCount +
              ') ; scan incomplet. Aucun succès global annoncé.');
          }

          for (const msg of pageData.messages) {
            if (job.cancelled) break;
            assertCurrentChat(ctx);
            const info = getMediaInfo(msg);
            if (!info) continue;
            const key = mediaIdentity(msg, info, ctx);
            if (job.seen.has(key)) continue;
            job.seen.add(key);
            job.found++;
            if (folder) {
              const name = fileName(msg, info, ctx.profile);
              if (findExistingDiskFile(folder, ctx, name, info)) {
                job.diskFound++;
                job.skipped++;
                // Recover old existing media even if a previous browser ledger
                // was erased. The selected local file is the proof for this run.
                if (!ledger.has(key)) {
                  ledger.add(key);
                  job.ledgerSafe = saveLedger(ctx, ledger) && job.ledgerSafe;
                }
                bulkStatus(job);
                continue;
              }
              if (folder.sessionDownloaded.has(key)) {
                job.skipped++;
                bulkStatus(job);
                continue;
              }
              if (ledger.has(key)) {
                job.missingFromDisk++;
                // A manually selected folder is authoritative for old files:
                // do not silently skip a deleted file just because it is in
                // localStorage. On confirmed GM_download success, ledger stays.
              }
            } else if (ledger.has(key)) {
              job.skipped++;
              bulkStatus(job);
              continue;
            }
            job.detail = 'Message #' + String(msg.mid) + ' · ' + info.type;
            bulkStatus(job);
            try {
              await saveMessage(msg, msg.peerId ?? ctx.peerId, ctx.profile);
              ledger.add(key);
              job.ledgerSafe = saveLedger(ctx, ledger) && job.ledgerSafe;
              if (folder) folder.sessionDownloaded.add(key);
              job.done++;
            } catch (err) {
              job.errors++;
              const failure = failureDescription(msg, info, err);
              if (job.failures.length < 100) job.failures.push(failure);
              console.error(PREFIX, 'Backup message échoué', key, failure, err);
              job.detail = 'Échec #' + failure.mid + ' : ' + failure.reason;
              saveLastReport(job);
            }
            bulkStatus(job);
            if (!job.cancelled) await delay(GAP_MS);
          }

          if (job.cancelled) break;
          if (pageData.isTopEnd) {
            endReached = true;
            break;
          }
          if (!pageData.next ||
              (cursor && String(pageData.next.mid) === String(cursor.mid) &&
              String(pageData.next.peerId) === String(cursor.peerId))) {
            failures++;
            if (failures >= 2) {
              throw new Error('Pagination bloquée avant la fin : scan incomplet.');
            }
          } else {
            failures = 0;
            cursor = pageData.next;
          }
          await delay(HISTORY_PAGE_GAP_MS);
        }
        if (endReached) job.finished++;
        else if (!job.cancelled) throw new Error('Plafond de pagination atteint : scan incomplet.');
      }
      job.complete = !job.cancelled && job.finished === HISTORY_FILTERS.length &&
        job.errors === 0 && job.ledgerSafe;
      job.stage = job.cancelled ? 'Arrêté · reprise possible'
        : job.complete ? 'Terminé · historique accessible parcouru'
          : 'Parcours terminé avec réserves';
      job.detail = !job.ledgerSafe ? 'Attention : historique anti-doublons non conservé sur disque.'
        : job.errors ? 'Des médias ont échoué : relancer pour réessayer les échecs.'
          : job.cancelled ? 'Relancer pour reprendre (déjà téléchargés ignorés).'
            : 'Tous les filtres ont atteint la fin de leur historique accessible.';
      toast(job.stage + ' · ' + job.done + ' enregistrés, ' + job.errors + ' erreurs.',
        !job.complete);
    } catch (err) {
      job.stage = 'Incomplet · interruption';
      job.detail = String(err.message || err);
      console.error(PREFIX, 'Backup incomplet', err);
      toast('Backup incomplet : ' + job.detail, true);
    } finally {
      lastBulkResult = job;
      saveLastReport(job);
      persistBackupState(job);
      bulkStatus(job);
      running = false;
      bulkJob = null;
      renderBulkProgress?.(job);
    }
  }

  function stopBackup() {
    if (!bulkJob) return;
    bulkJob.cancelled = true;
    bulkJob.stage = 'Arrêt demandé · fin du fichier en cours…';
    bulkStatus(bulkJob);
  }

  function addContextAction(menu) {
    if (!pending || menu.querySelector('#jkl-tg-single')) return;
    let msg;
    try { msg = getMessage(pending.peerId, pending.mid); } catch { return; }
    if (!getMediaInfo(msg)) return;
    const native = menu.querySelector('.btn-menu-item');
    if (!native || !native.parentElement) return;
    const action = document.createElement('div');
    action.id = 'jkl-tg-single';
    action.className = 'btn-menu-item rp-overflow';
    action.style.cursor = 'pointer';
    action.setAttribute('role', 'menuitem');
    const icon = document.createElement('span');
    icon.className = 'btn-menu-item-icon';
    icon.textContent = '↓';
    const label = document.createElement('span');
    label.className = 'btn-menu-item-text';
    label.textContent = 'JKL Backup · Télécharger + renommer';
    action.append(icon, label);
    // Context menus may be reused: never hold a stale message reference.
    action.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      const ref = pending ? {...pending} : null;
      if (!ref) return toast('JKL : média ciblé introuvable.', true);
      void saveSingle(ref);
    });
    native.parentElement.insertBefore(action, native);
  }

  function addSelectionAction(wrapper) {
    const bar = wrapper.querySelector('.selection-container');
    if (!bar || bar.querySelector('#jkl-tg-batch')) return;
    const button = document.createElement('button');
    button.id = 'jkl-tg-batch';
    button.type = 'button';
    button.className = 'btn-primary btn-transparent text-bold';
    button.style.cssText = 'width:auto;cursor:pointer;margin:0 8px;padding:0 8px;white-space:nowrap';
    button.textContent = 'JKL Télécharger';
    button.title = 'Télécharger et renommer les photos et vidéos sélectionnées';
    button.addEventListener('click', () => { void saveSelection(button); });
    bar.appendChild(button);
  }

  function captureTarget(target) {
    const mediaRef = readRef(target);
    if (mediaRef) { pending = mediaRef; return; }
    const bubble = target instanceof Element ? target.closest('[data-mid]') : null;
    if (!bubble) { pending = null; return; }
    const peerId = bubble.dataset.peerId || bubble.closest('[data-peer-id]')?.dataset.peerId || page.appImManager?.chat?.peerId;
    const mid = bubble.dataset.mid;
    pending = peerId != null && mid != null ? { peerId, mid } : null;
  }


  // Always-visible launcher: the previous version had no discoverable entrypoint
  // until a particular right-click menu or selection UI was opened.
  let lastHoveredRef = null;
  let refreshDock = null;
  let refreshBackupIndicator = null;

  function isWebK() {
    return location.hostname === 'webk.telegram.org' ||
      (location.hostname === 'web.telegram.org' && location.pathname.startsWith('/k'));
  }

  // Album items have their own data-mid. Resolve the nearest media's ID.
  function readRef(element) {
    if (!(element instanceof Element)) return null;
    const media = element.closest(
      '.album-item, .media-photo, .media-video, .media-container, ' +
      '.media-container-aspecter, .video-container'
    );
    const item = media?.closest('[data-mid]');
    if (!item) return null;
    const peerId = item.dataset.peerId ||
      item.closest('[data-peer-id]')?.dataset.peerId ||
      page.appImManager?.chat?.peerId;
    const mid = item.dataset.mid;
    return peerId != null && mid != null && mid !== '' ? {peerId, mid} : null;
  }

  document.addEventListener('mouseover', event => {
    const ref = readRef(event.target);
    if (ref && (ref.mid !== lastHoveredRef?.mid || String(ref.peerId) !== String(lastHoveredRef?.peerId))) {
      lastHoveredRef = ref;
      refreshDock?.();
    }
  }, true);

  function getSoloRef() {
    const viewerOpen = !!document.querySelector('.media-viewer-whole.active');
    if (viewerOpen) {
      const t = page.appMediaViewer?.target;
      if (t && t.peerId != null && t.mid != null) return {peerId: t.peerId, mid: t.mid};
      throw new Error('Visionneuse ouverte : identifiant du média inaccessible. Ferme-la et survole le message.');
    }
    return lastHoveredRef;
  }

  function diagnostics() {
    const yes = x => x ? 'OK' : 'INDISPONIBLE';
    return [
      'JKL Telegram Backup v0.2.6',
      'URL : ' + location.href,
      'WebK : ' + yes(isWebK()),
      'Moteur renommage : ' + yes(typeof page.appDownloadManager?.downloadMedia === 'function'),
      'GM_download : ' + yes(typeof GM_download === 'function'),
      'Backup : ' + (reportForOpenChat() || 'inactif'),
      'Mode Tampermonkey : ' + (gmDownloadMode() || 'inconnu'),
      'Lecture messages : ' + yes(typeof page.mtprotoMessagePort?.getMessageByPeer === 'function'),
      'Sélection : ' + yes(typeof page.appImManager?.chat?.selection?.getSelectedMessages === 'function'),
      'Historique : ' + yes(typeof (page.appImManager?.chat?.managers?.appMessagesManager || page.appImManager?.managers?.appMessagesManager)?.getHistory === 'function'),
      'Dernier message survolé : ' + (lastHoveredRef ? lastHoveredRef.mid : 'aucun')
    ].join('\n');
  }

  function installDrag(root, handle, panel) {
    const key = 'jkl-tg-backup-dock-position-v1';
    const position = (x, y) => {
      const rect = root.getBoundingClientRect();
      const width = Math.max(rect.width, panel.hidden ? 0 : (panel.offsetWidth || 316));
      const height = panel.hidden ? rect.height : 42 + (panel.offsetHeight || 250);
      const clamp = (value, limit) => Math.max(8, Math.min(value, Math.max(8, limit - 8)));
      root.style.left = clamp(x, window.innerWidth - width) + 'px';
      root.style.top = clamp(y, window.innerHeight - height) + 'px';
      root.style.transform = 'none';
    };
    const save = () => {
      try {
        localStorage.setItem(key, JSON.stringify({
          x: parseFloat(root.style.left), y: parseFloat(root.style.top)
        }));
      } catch (err) { console.warn(PREFIX, 'Position non enregistrée', err); }
    };
    try {
      const p = JSON.parse(localStorage.getItem(key) || 'null');
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) position(p.x, p.y);
    } catch (err) { console.warn(PREFIX, 'Position non restaurée', err); }
    let drag = null;
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      delete handle.dataset.jklDragClick;
      const rect = root.getBoundingClientRect();
      drag = { id:e.pointerId, x:e.clientX, y:e.clientY,
        left:rect.left, top:rect.top, moved:false };
      handle.setPointerCapture?.(e.pointerId);
    });
    handle.addEventListener('pointermove', e => {
      if (!drag || drag.id !== e.pointerId) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 6) return;
      drag.moved = true;
      e.preventDefault();
      position(drag.left + dx, drag.top + dy);
    });
    const finish = e => {
      if (!drag || drag.id !== e.pointerId) return;
      if (drag.moved) {
        handle.dataset.jklDragClick = '1';
        save();
      }
      drag = null;
      if (handle.hasPointerCapture?.(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    window.addEventListener?.('resize', () => {
      if (root.style.transform === 'none') {
        position(parseFloat(root.style.left), parseFloat(root.style.top));
        save();
      }
    });
  }

  function mountDock() {
    if (typeof document.createElement !== 'function' || !document.body?.appendChild) return;
    if (document.getElementById('jkl-tg-dock')) return;
    const root = document.createElement('section');
    root.id = 'jkl-tg-dock';
    root.setAttribute('aria-label', 'JKL Telegram Backup');
    root.style.cssText = [
      'position:fixed', 'top:76px', 'left:50%', 'transform:translateX(-50%)',
      'z-index:2147483643', 'font:13px system-ui,sans-serif',
      'color:#eaf4ff', 'max-width:calc(100vw - 24px)',
      'filter:drop-shadow(0 4px 13px #0006)'
    ].join(';');
    root.innerHTML = [
      '<button type="button" id="jkl-tg-toggle" aria-expanded="false"',
      ' style="cursor:grab;touch-action:none;user-select:none;border:1px solid #6faec9;background:#183d54;',
      'color:#fff;padding:8px 13px;border-radius:20px;font:600 13px system-ui,sans-serif">',
      '↓ JKL Telegram Backup <small style="opacity:.75">v0.2.6</small>',
      '<span id="jkl-tg-state-chip" style="display:inline-block;margin-left:8px;',
      'padding:3px 7px;border:1px solid #617d8d;border-radius:14px;',
      'font:600 11px system-ui,sans-serif;vertical-align:middle">',
      'Prêt</span></button>',
      '<section id="jkl-tg-panel" hidden style="box-sizing:border-box;position:absolute;',
      'left:0;top:42px;transform:none;width:316px;',
      'max-width:calc(100vw - 24px);max-height:calc(100vh - 120px);overflow-y:auto;',
      'padding:12px;border-radius:13px;',
      'background:#142b39;border:1px solid #557083;line-height:1.45">',
      '<strong>JKL Telegram Backup</strong>',
      '<div id="jkl-tg-final-state" role="status" aria-live="polite"',
      ' style="margin-top:8px;padding:8px 10px;border-radius:8px;',
      'font-weight:700;border:1px solid #617d8d">Prêt</div>',
      '<div id="jkl-tg-status" style="white-space:pre-line;margin:8px 0 11px;',
      'font-size:12px;color:#b6d4df"></div>',
      '<button id="jkl-tg-solo" type="button" style="cursor:pointer;padding:8px;',
      'border:0;border-radius:7px;background:#34718b;color:white;margin:0 5px 6px 0">',
      'Télécharger le média survolé</button>',
      '<button id="jkl-tg-selected" type="button" style="cursor:pointer;padding:8px;',
      'border:0;border-radius:7px;background:#34718b;color:white;margin-bottom:6px">',
      'Télécharger la sélection</button>',
      '<div style="margin:10px 0 8px;padding-top:10px;border-top:1px solid #557083">',
      '<strong>Backup complet du canal ouvert</strong></div>',
      '<button id="jkl-tg-folder" type="button" style="cursor:pointer;padding:8px;',
      'border:1px solid #7db8d1;border-radius:7px;background:#23485c;',
      'color:white;margin-bottom:7px">Choisir un dossier existant</button>',
      '<input type="file" id="jkl-tg-folder-input" webkitdirectory directory multiple hidden>',
      '<div id="jkl-tg-folder-status" style="font-size:11px;',
      'color:#b8d5e7;margin-bottom:9px;white-space:pre-line">',
      'Dossier local : non sélectionné.</div>',
      '<button id="jkl-tg-all" type="button" style="cursor:pointer;padding:8px;',
      'border:0;border-radius:7px;background:#168064;color:white;margin-right:6px">',
      'Tout récupérer</button>',
      '<button id="jkl-tg-stop" type="button" disabled',
      ' style="cursor:pointer;padding:8px;border:1px solid #b96767;border-radius:7px;',
      'background:transparent;color:#f1aaaa">Arrêter</button>',
      '<progress id="jkl-tg-bulk-progress" style="display:none;width:100%;margin-top:9px"></progress>',
      '<div id="jkl-tg-bulk-status" role="status" aria-live="polite"',
      ' style="white-space:pre-line;font-size:12px;margin:8px 0;color:#b8d5e7">',
      'Prêt à parcourir les photos, vidéos et fichiers médias accessibles.</div>',
      '<button id="jkl-tg-diag" type="button" style="cursor:pointer;padding:7px;',
      'border:1px solid #50758b;border-radius:7px;background:transparent;color:#eaf4ff">',
      'Copier diagnostic</button>',
      '<button id="jkl-tg-copy-errors" type="button" style="cursor:pointer;padding:7px;',
      'margin:6px;border:1px solid #50758b;border-radius:7px;',
      'background:transparent;color:#eaf4ff">Copier rapport du backup</button>',
      '<a id="jkl-tg-webk" href="https://web.telegram.org/k/"',
      ' style="display:none;margin-top:8px;color:#97dcff">',
      'Ouvrir Telegram WebK</a>',
      '<div style="margin-top:9px;font-size:11px;opacity:.75">',
      'Tout récupérer = photos, vidéos et médias envoyés en fichier du canal ouvert.',
      ' Arrêt et reprise possibles, sans retélécharger les médias déjà enregistrés.',
      ' Photos sans nom original : photo_ID.jpg. Version expérimentale.</div>',
      '</section>'
    ].join('');
    document.body.appendChild(root);
    const toggle = root.querySelector('#jkl-tg-toggle');
    const panel = root.querySelector('#jkl-tg-panel');
    const status = root.querySelector('#jkl-tg-status');
    const webk = root.querySelector('#jkl-tg-webk');
    const allButton = root.querySelector('#jkl-tg-all');
    const stopButton = root.querySelector('#jkl-tg-stop');
    const bulkLabel = root.querySelector('#jkl-tg-bulk-status');
    const bulkProgress = root.querySelector('#jkl-tg-bulk-progress');
    const folderButton = root.querySelector('#jkl-tg-folder');
    const folderInput = root.querySelector('#jkl-tg-folder-input');
    const folderStatus = root.querySelector('#jkl-tg-folder-status');
    let pickerTarget = null;
    const chip = root.querySelector('#jkl-tg-state-chip');
    const panelState = root.querySelector('#jkl-tg-final-state');
    const colors = {
      ready: {background:'#314551', color:'#e1ebf3', border:'#60798a'},
      running: {background:'#19547a', color:'#f1fbff', border:'#3a9bca'},
      stopping: {background:'#80552b', color:'#fff2d8', border:'#d99c4c'},
      complete: {background:'#166447', color:'#f0fff7', border:'#31bf85'},
      warning: {background:'#785024', color:'#fff4dc', border:'#dea452'},
      stopped: {background:'#785024', color:'#fff4dc', border:'#dea452'},
      incomplete: {background:'#873538', color:'#fff1f1', border:'#e77878'}
    };
    refreshBackupIndicator = () => {
      const state = statusForOpenChat();
      const palette = colors[state.kind] || colors.ready;
      for (const el of [chip, panelState]) {
        if (el.textContent !== state.label) el.textContent = state.label;
        if (el.dataset.jklState === state.kind) continue;
        el.dataset.jklState = state.kind;
        el.style.backgroundColor = palette.background;
        el.style.color = palette.color;
        el.style.borderColor = palette.border;
      }
    };
    const visibleJob = job => sameBackupChat(job?.ctx, currentReportContext());
    renderBulkProgress = job => {
      const active = Boolean(bulkJob);
      allButton.disabled = active;
      folderButton.disabled = active;
      stopButton.disabled = !active || bulkJob?.cancelled;
      bulkLabel.textContent = visibleJob(job) ? bulkText(job) :
        (reportForOpenChat() || 'Prêt : ouvre un canal puis clique sur Tout récupérer.');
      bulkProgress.style.display = active ? 'block' : 'none';
      if (active) bulkProgress.removeAttribute('value');
      const reportCtx = currentReportContext();
      const selected = reportCtx && sameBackupChat(localFolderIndex?.ctx, reportCtx)
        ? localFolderIndex : null;
      folderStatus.textContent = selected
        ? folderSelectionStatus({...reportCtx, profile:selected.profile})
        : 'Dossier local : non sélectionné (reprise par historique uniquement).';
      refreshBackupIndicator();
    };

    const refresh = () => {
      const k = isWebK();
      const downloader = typeof page.appDownloadManager?.downloadMedia === 'function';
      const lookup = typeof page.mtprotoMessagePort?.getMessageByPeer === 'function';
      const history = typeof (page.appImManager?.chat?.managers?.appMessagesManager ||
        page.appImManager?.managers?.appMessagesManager)?.getHistory === 'function';
      status.textContent = (k ? 'WebK : OK' : 'WebK : NON (version non prise en charge)') +
        '\nMoteur renommage : ' + (downloader ? 'OK' : 'indisponible') +
        '\nAccès aux messages : ' + (lookup ? 'OK' : 'indisponible') +
        '\nAPI historique : ' + (history ? 'OK' : 'indisponible') +
        '\nDossier profil : ' + (typeof GM_download === 'function' ? 'GM_download disponible' : 'GM_download indisponible') +
        ' (mode ' + (gmDownloadMode() || 'inconnu') + ')' +
        '\nMédia ciblé : ' + (lastHoveredRef ? '#' + lastHoveredRef.mid : 'aucun (survole une photo/vidéo)');
      webk.style.display = k ? 'none' : 'block';
      webk.href = 'https://web.telegram.org/k/' + location.hash;
    };
    refreshDock = refresh;
    installDrag(root, toggle, panel);
    toggle.addEventListener('click', () => {
      if (toggle.dataset.jklDragClick === '1') {
        delete toggle.dataset.jklDragClick;
        return;
      }
      panel.hidden = !panel.hidden;
      panel.style.display = panel.hidden ? 'none' : 'block';
      toggle.setAttribute('aria-expanded', String(!panel.hidden));
      refresh();
      renderBulkProgress(bulkJob);
    });
    panel.style.display = 'none';
    root.querySelector('#jkl-tg-solo').addEventListener('click', async () => {
      if (!isWebK()) return toast('Ouvre Telegram WebK pour utiliser ce mode.', true);
      let ref;
      try { ref = getSoloRef(); } catch (err) { return toast(err.message, true); }
      if (!ref) return toast('Survole une photo/vidéo dans le chat avant de cliquer.', true);
      await saveSingle(ref);
      refresh();
    });
    root.querySelector('#jkl-tg-selected').addEventListener('click', async event => {
      if (!isWebK()) return toast('Ouvre Telegram WebK pour utiliser ce mode.', true);
      await saveSelection(event.currentTarget);
      refresh();
    });
    folderButton.addEventListener('click', () => {
      if (running || bulkJob) return toast('Attends la fin du backup.', true);
      if (page.appImManager?.chat?.peerId == null) {
        return toast('Ouvre une conversation Telegram avant de choisir le dossier.', true);
      }
      // Capture the original chat before the native picker is opened.
      // File selection can take minutes; user may navigate meanwhile.
      pickerTarget = currentReportContext();
      // Keep file-dialog activation synchronous with the user click.
      folderInput.click();
    });
    folderInput.addEventListener('change', async () => {
      const files = folderInput.files;
      if (!files?.length) {
        pickerTarget = null;
        return;
      }
      try {
        if (running || bulkJob) throw new Error('Un backup est en cours.');
        if (!pickerTarget || !sameBackupChat(pickerTarget, currentReportContext())) {
          throw new Error('Conversation changée pendant le choix du dossier.');
        }
        const ctx = await bulkContext();
        if (!sameBackupChat(ctx, pickerTarget)) {
          throw new Error('Conversation changée pendant la lecture du dossier.');
        }
        const folder = indexLocalFolder(files, ctx);
        assertCurrentChat(ctx);
        localFolderIndex = folder;
        toast('Dossier indexé : ' + folder.relevant + ' fichier(s) du profil.');
      } catch (error) {
        toast('Dossier non utilisé : ' + (error?.message || error), true);
      } finally {
        pickerTarget = null;
        folderInput.value = '';
        renderBulkProgress?.(bulkJob || lastBulkResult);
      }
    });
    allButton.addEventListener('click', () => { void backupAll(); });
    stopButton.addEventListener('click', stopBackup);
    renderBulkProgress(lastBulkResult);
    window.addEventListener?.('hashchange', () => {
      renderBulkProgress(bulkJob);
    });
    root.querySelector('#jkl-tg-copy-errors').addEventListener('click', async () => {
      const report = reportForOpenChat();
      if (!report) return toast('Aucun rapport pour cette conversation.', true);
      try {
        await navigator.clipboard.writeText(report);
        toast('Rapport du backup copié.');
      } catch {
        console.info(PREFIX, 'Rapport backup', report);
        toast('Rapport affiché dans la console F12.', true);
      }
    });
    root.querySelector('#jkl-tg-diag').addEventListener('click', async () => {
      const report = diagnostics();
      try {
        await navigator.clipboard.writeText(report);
        toast('Diagnostic copié.');
      } catch {
        console.info(PREFIX, report);
        toast('Diagnostic affiché dans la console (F12).', true);
      }
    });
    document.documentElement.dataset.jklTelegramBackup = '0.2.6';
    console.info(PREFIX, 'Panneau v0.2.6 initialisé. '+ diagnostics());
  }

  document.addEventListener('contextmenu', e => captureTarget(e.target), true);
  document.addEventListener('mouseup', e => { if (e.button === 2) captureTarget(e.target); }, true);

  function process(node) {
    if (!(node instanceof Element)) return;
    if (node.id === 'bubble-contextmenu') addContextAction(node);
    if (node.classList.contains('selection-wrapper')) addSelectionAction(node);
    node.querySelectorAll('#bubble-contextmenu').forEach(addContextAction);
    node.querySelectorAll('.selection-wrapper').forEach(addSelectionAction);
  }

  let lastObservedChat = null;
  const observer = new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) process(node);
    const ctx = currentReportContext();
    const key = ctx ? statusKey(ctx) : '';
    if (key !== lastObservedChat) {
      lastObservedChat = key;
      refreshBackupIndicator?.();
      // The diagnostic report also belongs to the currently open chat.
      if (!bulkJob) renderBulkProgress?.(null);
    }
  });
  const start = () => {
    mountDock();
    observer.observe(document.body, { childList: true, subtree: true });
    document.querySelectorAll('#bubble-contextmenu,.selection-wrapper').forEach(process);
    console.info(`${PREFIX} v0.2.6 pret (WebK).`);
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
