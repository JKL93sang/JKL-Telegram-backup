// ==UserScript==
// @name         JKL Telegram Backup
// @namespace    https://github.com/JKL93sang
// @version      0.1.5
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
 * v0.1.5 - prototype WebK, sans dependances ni serveur tiers.
 * Exploite downloadToDisc({ media, fileName }) de Telegram WebK.
 * Les messages doivent etre accessibles dans la session Telegram ouverte.
 * Limites: pas de scan historique, pas de controle des doublons, pas d'album
 * automatique hors messages selectionnes, pas de choix d'arborescence disque.
 * ATTENTION : les fonctions internes WebK utilisees par ce prototype ne sont
 * pas garanties exposees globalement (window); fonctionnement non valide.
 * Conserver le script de secours jusqu'aux tests en situation reelle.
 */
(() => {
  'use strict';

  const PREFIX = '[JKL TG Backup]';
  const GAP_MS = 550;
  // Blob downloads consume memory: never silently save unrenamed large files.
  const MAX_RENAMED_BYTES = 512 * 1024 * 1024;
  let pending = null;
  let running = false;
  let toastTimer = null;

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
    if (!isVideo && !isGif) return null;

    const extMatch = orig.match(/\.([a-z0-9]{2,6})$/i);
    const acceptable = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'gif']);
    let ext = extMatch && acceptable.has(extMatch[1].toLowerCase()) ? extMatch[1].toLowerCase() : '';
    if (!ext) ext = isGif ? 'gif' : ({ 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv' }[mime] || 'mp4');
    return { media: doc, type: isGif ? 'GIF' : 'VIDEO', ext, originalName: orig || null };
  }

  function currentChatLabel() {
    const selectors = [
      '#column-center .chat-info .peer-title',
      '#column-center .chat-info .title',
      '#column-center .person .peer-title',
      '#column-center .peer-title'
    ];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      const label = el?.textContent?.trim();
      if (label) return filePart(label, 'Telegram', 70);
    }
    return 'Telegram';
  }

  function fileName(msg, mediaInfo, profile = currentChatLabel()) {
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
      originalBase = filePart(baseWithoutExt, mediaInfo.type.toLowerCase() + '_' + mid, 120);
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
          onerror: event => complete(new Error(
            'Téléchargement dans le dossier échoué (' +
            String(event?.error || event?.details || 'inconnu') +
            '). Vérifie les permissions et le mode Browser API de Tampermonkey.'
          )),
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

  async function saveMessage(msg, peerId) {
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
    const profile = currentChatLabel();
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
      'JKL Telegram Backup v0.1.5',
      'URL : ' + location.href,
      'WebK : ' + yes(isWebK()),
      'Moteur renommage : ' + yes(typeof page.appDownloadManager?.downloadMedia === 'function'),
      'GM_download : ' + yes(typeof GM_download === 'function'),
      'Mode Tampermonkey : ' + (gmDownloadMode() || 'inconnu'),
      'Lecture messages : ' + yes(typeof page.mtprotoMessagePort?.getMessageByPeer === 'function'),
      'Sélection : ' + yes(typeof page.appImManager?.chat?.selection?.getSelectedMessages === 'function'),
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
      '↓ JKL Telegram Backup <small style="opacity:.75">v0.1.5</small></button>',
      '<section id="jkl-tg-panel" hidden style="box-sizing:border-box;position:absolute;',
      'left:0;top:42px;transform:none;width:316px;',
      'max-width:calc(100vw - 24px);padding:12px;border-radius:13px;',
      'background:#142b39;border:1px solid #557083;line-height:1.45">',
      '<strong>JKL Telegram Backup</strong>',
      '<div id="jkl-tg-status" style="white-space:pre-line;margin:8px 0 11px;',
      'font-size:12px;color:#b6d4df"></div>',
      '<button id="jkl-tg-solo" type="button" style="cursor:pointer;padding:8px;',
      'border:0;border-radius:7px;background:#34718b;color:white;margin:0 5px 6px 0">',
      'Télécharger le média survolé</button>',
      '<button id="jkl-tg-selected" type="button" style="cursor:pointer;padding:8px;',
      'border:0;border-radius:7px;background:#34718b;color:white;margin-bottom:6px">',
      'Télécharger la sélection</button>',
      '<button id="jkl-tg-diag" type="button" style="cursor:pointer;padding:7px;',
      'border:1px solid #50758b;border-radius:7px;background:transparent;color:#eaf4ff">',
      'Copier diagnostic</button>',
      '<a id="jkl-tg-webk" href="https://web.telegram.org/k/"',
      ' style="display:none;margin-top:8px;color:#97dcff">',
      'Ouvrir Telegram WebK</a>',
      '<div style="margin-top:9px;font-size:11px;opacity:.75">',
      'Dossier automatique : Téléchargements/NomDuProfil/ via Tampermonkey Browser API.',
      ' Photos sans nom original : photo_ID.jpg. Version expérimentale.</div>',
      '</section>'
    ].join('');
    document.body.appendChild(root);
    const toggle = root.querySelector('#jkl-tg-toggle');
    const panel = root.querySelector('#jkl-tg-panel');
    const status = root.querySelector('#jkl-tg-status');
    const webk = root.querySelector('#jkl-tg-webk');

    const refresh = () => {
      const k = isWebK();
      const downloader = typeof page.appDownloadManager?.downloadMedia === 'function';
      const lookup = typeof page.mtprotoMessagePort?.getMessageByPeer === 'function';
      status.textContent = (k ? 'WebK : OK' : 'WebK : NON (version non prise en charge)') +
        '\nMoteur renommage : ' + (downloader ? 'OK' : 'indisponible') +
        '\nAccès aux messages : ' + (lookup ? 'OK' : 'indisponible') +
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
    document.documentElement.dataset.jklTelegramBackup = '0.1.5';
    console.info(PREFIX, 'Panneau v0.1.5 initialisé. '+ diagnostics());
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

  const observer = new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) process(node);
  });
  const start = () => {
    mountDock();
    observer.observe(document.body, { childList: true, subtree: true });
    document.querySelectorAll('#bubble-contextmenu,.selection-wrapper').forEach(process);
    console.info(`${PREFIX} v0.1.5 pret (WebK).`);
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
