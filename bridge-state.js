(function () {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);

  const B = {
    facebookAccountBar: $('#facebookAccountBar'),
    facebookNameDisplay: $('#facebookNameDisplay'),
    facebookUidDisplay: $('#facebookUidDisplay'),
    facebookLogoutBtn: $('#facebookLogoutBtn'),
    facebookCookiesInput: $('#facebookCookiesInput'),
    apifyActorIdInput: $('#apifyActorIdInput'),
    apifyApiTokenInput: $('#apifyApiTokenInput'),
    apifyApiTokenToggle: $('#apifyApiTokenToggle'),
    fbGroupIdInput: $('#fbGroupIdInput'),
    groupLimitInput: $('#groupLimitInput'),
    scanSourceModeSelect: $('#scanSourceModeSelect'),
    loopPauseSecondsInput: $('#loopPauseSecondsInput'),
    linkPauseSecondsInput: $('#linkPauseSecondsInput'),
    fbPostLinkInput: $('#fbPostLinkInput'),
    fbPostLinkCounter: $('#fbPostLinkCounter'),
    dashboardAutoRunBtn: $('#dashboardAutoRunBtn'),
    scanGroupLinksBtn: $('#scanGroupLinksBtn'),
    apifyScanBtn: $('#apifyScanBtn'),
    stopClosedLoopBtn: $('#stopClosedLoopBtn'),
    autoWorkflowBtn: $('#autoWorkflowBtn'),
    commentCurrentTabBtn: $('#commentCurrentTabBtn'),
    bridgeStatus: $('#bridgeStatus'),
    articleInput: $('#articleInput'),
    output: $('#output'),
    fbMaxChars: $('#fbMaxChars'),
    clearCommentedLinksBtn: $('#clearCommentedLinksBtn'),
    commentedLinksBox: $('#commentedLinksBox'),
    commentedCountStat: $('#commentedCountStat'),
    footerCommentedCount: $('#footerCommentedCount'),
    clearRemovedLinksBtn: $('#clearRemovedLinksBtn'),
    removedLinksBox: $('#removedLinksBox'),
    removedCountStat: $('#removedCountStat'),
    footerRemovedCount: $('#footerRemovedCount')
  };

  const STORE = {
    facebookCookies: 'truong_fb_bridge_facebook_cookies_v1',
    apifyActorId: 'truong_fb_bridge_apify_actor_id_v1',
    apifyToken: 'truong_fb_bridge_apify_token_v1',
    groupIds: 'truong_fb_bridge_group_ids_v1',
    groupLimit: 'truong_fb_bridge_group_limit_v1',
    scanSourceMode: 'truong_fb_bridge_scan_source_mode_v1',
    loopPauseSeconds: 'truong_fb_bridge_loop_pause_seconds_v1',
    oldLoopPauseMinutes: 'truong_fb_bridge_loop_pause_minutes_v1',
    linkPauseSeconds: 'truong_fb_bridge_link_pause_seconds_v1',
    postLinks: 'truong_fb_bridge_post_links_v1',
    postCaptions: 'truong_fb_bridge_post_captions_v1',
    commented: 'truong_fb_bridge_commented_links_v1',
    removed: 'truong_fb_bridge_removed_links_v1'
  };

  const APIFY_ACTOR_IDS = [
    'powerful_bachelor~facebook-group-scraper',
    'caprolok~facebook-groups-scraper'
  ];
  const DEFAULT_APIFY_ACTOR_ID = 'caprolok~facebook-groups-scraper';

  const bridgeState = {
    closedLoopRunning: false,
    activeReadTabId: null,
    activeReadLink: '',
    bridgeBusy: false,
    processStatus: null,
    processSerial: 0
  };

  try { localStorage.removeItem('truong_fb_bridge_extension_id_v1'); } catch {}

  function save(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function load(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch { return fallback; }
  }

  function text(value) {
    return String(value || '').trim();
  }

  function clampNumber(value, fallback, min, max) {
    if (String(value ?? '').trim() === '') return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }


  function getScanSourceMode() {
    const allowed = new Set(['group_latest', 'group_top']);
    const raw = String(B.scanSourceModeSelect?.value || load(STORE.scanSourceMode, 'group_latest') || 'group_latest');
    const value = allowed.has(raw) ? raw : 'group_latest';
    if (B.scanSourceModeSelect) B.scanSourceModeSelect.value = value;
    save(STORE.scanSourceMode, value);
    return value;
  }

  function getGroupLimit() {
    const value = Math.round(clampNumber(B.groupLimitInput?.value, 5, 1, 50));
    if (B.groupLimitInput) B.groupLimitInput.value = String(value);
    save(STORE.groupLimit, B.groupLimitInput?.value || String(value));
    return value;
  }

  function getLoopPauseSeconds() {
    let fallback = 240;
    const savedSeconds = load(STORE.loopPauseSeconds, null);
    if (savedSeconds === null) {
      const oldMinutes = load(STORE.oldLoopPauseMinutes, null);
      if (oldMinutes !== null && oldMinutes !== '') fallback = Math.round(clampNumber(oldMinutes, 5, 0, 1440)) * 60;
    }
    const value = Math.round(clampNumber(B.loopPauseSecondsInput?.value, fallback, 0, 86400));
    if (B.loopPauseSecondsInput) B.loopPauseSecondsInput.value = String(value);
    save(STORE.loopPauseSeconds, B.loopPauseSecondsInput?.value || String(value));
    return value;
  }

  function getLinkPauseSeconds() {
    const value = Math.round(clampNumber(B.linkPauseSecondsInput?.value, 60, 0, 86400));
    if (B.linkPauseSecondsInput) B.linkPauseSecondsInput.value = String(value);
    save(STORE.linkPauseSeconds, B.linkPauseSecondsInput?.value || String(value));
    return value;
  }

  function setBridgeStatus(message, type = '') {
    if (!B.bridgeStatus) return;
    const isHiddenSource = B.bridgeStatus.classList.contains('automation-status-source');
    B.bridgeStatus.textContent = message;
    B.bridgeStatus.className = (isHiddenSource ? 'automation-status-source hidden' : 'automation-status') + (type ? ' ' + type : '');
  }

  function reportProcess(detail = {}) {
    const payload = detail && typeof detail === 'object' ? detail : {};
    bridgeState.processSerial += 1;
    const next = {
      ...(bridgeState.processStatus || {}),
      ...payload,
      historyMessage: payload.historyMessage || '',
      historyTag: payload.historyTag || '',
      historyLevel: payload.historyLevel || '',
      historyKey: payload.historyKey || '',
      historyMode: payload.historyMode || '',
      statDelta: payload.statDelta && typeof payload.statDelta === 'object' ? payload.statDelta : null,
      resetStats: payload.resetStats === true,
      sequence: bridgeState.processSerial,
      timestamp: Date.now()
    };
    bridgeState.processStatus = next;
    window.dispatchEvent(new CustomEvent('autovip:process', { detail: next }));
    return next;
  }

  function getProcessStatus() {
    return bridgeState.processStatus ? { ...bridgeState.processStatus } : null;
  }

  function addInputSave(el, key) {
    if (!el) return;
    el.value = load(key, '') || '';
    const persist = () => save(key, el.value);
    el.addEventListener('input', persist);
    el.addEventListener('change', persist);
  }

  function parseLines(raw) {
    return String(raw || '')
      .split(/[\n,]+/)
      .map(item => item.trim())
      .filter(Boolean);
  }

  function normalizeUrl(raw) {
    try {
      const url = new URL(String(raw).trim());
      url.hash = '';
      url.protocol = 'https:';
      url.hostname = url.hostname.toLowerCase().replace(/^(m|mbasic|web)\.facebook\.com$/i, 'www.facebook.com');

      const pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
      const groupPostMatch = pathname.match(/^\/groups\/([^/?#]+)\/(?:posts|permalink)\/([^/?#]+)$/i);
      if (url.hostname === 'www.facebook.com' && groupPostMatch?.[1] && groupPostMatch?.[2]) {
        const encodePart = value => {
          try {
            return encodeURIComponent(decodeURIComponent(value));
          } catch {
            return encodeURIComponent(value);
          }
        };
        const groupId = encodePart(groupPostMatch[1]);
        const postId = encodePart(groupPostMatch[2]);
        return `https://www.facebook.com/groups/${groupId}/permalink/${postId}/`;
      }

      url.pathname = pathname;
      const drop = ['fbclid', 'mibextid', '__cft__', '__tn__', 'ref', 'refid', 'paipv'];
      drop.forEach(key => url.searchParams.delete(key));
      return url.toString();
    } catch {
      return String(raw || '').trim();
    }
  }

  function isGroupPermalinkUrl(value) {
    try {
      const url = new URL(String(value || '').trim());
      const hostname = url.hostname.toLowerCase().replace(/^(m|mbasic|web)\.facebook\.com$/i, 'www.facebook.com');
      const pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
      return hostname === 'www.facebook.com'
        && /^\/groups\/[^/?#]+\/permalink\/[^/?#]+$/i.test(pathname);
    } catch {
      return false;
    }
  }

  function uniqueLinks(lines) {
    const out = [];
    const seen = new Set();
    for (const line of lines) {
      const clean = normalizeUrl(line);
      if (!clean || !isGroupPermalinkUrl(clean) || seen.has(clean)) continue;
      seen.add(clean);
      out.push(clean);
    }
    return out;
  }

  function getCommentedLinks() {
    return uniqueLinks(load(STORE.commented, []));
  }

  function renderCommentedLinks() {
    const list = getCommentedLinks();
    if (B.commentedLinksBox) B.commentedLinksBox.value = list.join('\n');
    if (B.commentedCountStat) B.commentedCountStat.textContent = String(list.length);
    if (B.footerCommentedCount) B.footerCommentedCount.textContent = String(list.length);
  }

  function getRemovedLinks() {
    return uniqueLinks(load(STORE.removed, []));
  }

  function renderRemovedLinks() {
    const list = getRemovedLinks();
    if (B.removedLinksBox) B.removedLinksBox.value = list.join('\n');
    if (B.removedCountStat) B.removedCountStat.textContent = String(list.length);
    if (B.footerRemovedCount) B.footerRemovedCount.textContent = String(list.length);
  }

  function filterLinksAgainstHistory(links) {
    const candidates = uniqueLinks(Array.isArray(links) ? links : parseLines(links));
    const commented = new Set(getCommentedLinks().map(normalizeUrl));
    const removed = new Set(getRemovedLinks().map(normalizeUrl));
    const accepted = [];
    const duplicateCommented = [];
    const duplicateRemoved = [];

    for (const link of candidates) {
      const key = normalizeUrl(link);
      if (commented.has(key)) {
        duplicateCommented.push(link);
        continue;
      }
      if (removed.has(key)) {
        duplicateRemoved.push(link);
        continue;
      }
      accepted.push(link);
    }

    return {
      links: accepted,
      duplicateCommented,
      duplicateRemoved,
      duplicateHistoryCount: duplicateCommented.length + duplicateRemoved.length,
      candidateCount: candidates.length
    };
  }

  function filterNewLinks(links) {
    return filterLinksAgainstHistory(links).links;
  }

  function normalizeCaptionValue(value, depth = 0, seen = new WeakSet()) {
    if (depth > 10 || value == null) return '';
    if (['string', 'number'].includes(typeof value)) return text(value);
    if (typeof value !== 'object' || seen.has(value)) return '';

    seen.add(value);
    if (Array.isArray(value)) {
      const result = value
        .map(item => normalizeCaptionValue(item, depth + 1, seen))
        .filter(Boolean)
        .join('\n')
        .trim();
      seen.delete(value);
      return result;
    }

    const preferredFields = ['text', 'content', 'value', 'description', 'message', 'body', 'caption'];
    const entries = Object.entries(value);
    for (const fieldName of preferredFields) {
      const entry = entries.find(([key]) => String(key).replace(/[^a-z0-9]/gi, '').toLowerCase() === fieldName);
      if (!entry) continue;
      const result = normalizeCaptionValue(entry[1], depth + 1, seen);
      if (result) {
        seen.delete(value);
        return result;
      }
    }

    for (const nestedValue of Object.values(value)) {
      const result = normalizeCaptionValue(nestedValue, depth + 1, seen);
      if (result) {
        seen.delete(value);
        return result;
      }
    }

    seen.delete(value);
    return '';
  }

  function getPostCaptionMap() {
    const stored = load(STORE.postCaptions, {});
    if (!stored || Array.isArray(stored) || typeof stored !== 'object') return {};
    const captions = {};
    for (const [url, caption] of Object.entries(stored)) {
      const key = normalizeUrl(url);
      const value = normalizeCaptionValue(caption);
      if (key && value) captions[key] = value;
    }
    return captions;
  }

  function setPostCaptions(records) {
    const captions = {};
    for (const record of Array.isArray(records) ? records : []) {
      const key = normalizeUrl(record?.url || record?.link);
      const caption = normalizeCaptionValue(
        record?.caption ??
        record?.post_caption ??
        record?.postCaption ??
        record?.post_text ??
        record?.postText ??
        record?.post_content ??
        record?.postContent ??
        ''
      );
      if (!key || !caption) continue;
      captions[key] = caption;
    }
    save(STORE.postCaptions, captions);
    return Object.keys(captions).length;
  }

  function getPostCaption(link) {
    return getPostCaptionMap()[normalizeUrl(link)] || '';
  }

  function removePostCaption(link) {
    const captions = getPostCaptionMap();
    const key = normalizeUrl(link);
    if (!key || !Object.prototype.hasOwnProperty.call(captions, key)) return;
    delete captions[key];
    save(STORE.postCaptions, captions);
  }

  function prunePostCaptions(links) {
    const allowed = new Set(uniqueLinks(Array.isArray(links) ? links : parseLines(links)).map(normalizeUrl));
    const captions = getPostCaptionMap();
    const nextCaptions = {};
    for (const [url, caption] of Object.entries(captions)) {
      if (allowed.has(normalizeUrl(url))) nextCaptions[url] = caption;
    }
    save(STORE.postCaptions, nextCaptions);
    return Object.keys(nextCaptions).length;
  }

  function updatePostLinkCounter(links = null) {
    if (!B.fbPostLinkCounter) return;
    const count = Array.isArray(links)
      ? links.length
      : filterNewLinks(parseLines(B.fbPostLinkInput?.value)).length;
    B.fbPostLinkCounter.textContent = `${count} link`;
  }

  function syncPostLinksInput() {
    if (!B.fbPostLinkInput) return;
    const links = filterNewLinks(parseLines(B.fbPostLinkInput.value));
    const value = links.join('\n');
    if (B.fbPostLinkInput.value !== value) B.fbPostLinkInput.value = value;
    save(STORE.postLinks, value);
    prunePostCaptions(links);
    updatePostLinkCounter(links);
  }

  function setPostLinks(links) {
    if (!B.fbPostLinkInput) return;
    B.fbPostLinkInput.value = filterNewLinks(links).join('\n');
    save(STORE.postLinks, B.fbPostLinkInput.value);
    prunePostCaptions(parseLines(B.fbPostLinkInput.value));
    B.fbPostLinkInput.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function getPostLinks() {
    return filterNewLinks(parseLines(B.fbPostLinkInput?.value));
  }

  function saveCommentedLink(link) {
    const list = getCommentedLinks();
    const clean = normalizeUrl(link);
    if (clean && !list.includes(clean)) list.unshift(clean);
    removePostCaption(clean);
    save(STORE.commented, list);
    renderCommentedLinks();
    syncPostLinksInput();
  }

  function saveRemovedLink(link) {
    const list = getRemovedLinks();
    const clean = normalizeUrl(link);
    if (clean && !list.includes(clean)) list.unshift(clean);
    removePostCaption(clean);
    save(STORE.removed, list);
    renderRemovedLinks();
    syncPostLinksInput();
  }

  function wirePostLinksInput() {
    if (!B.fbPostLinkInput) return;
    B.fbPostLinkInput.value = load(STORE.postLinks, '') || '';
    syncPostLinksInput();
    B.fbPostLinkInput.addEventListener('input', syncPostLinksInput);
  }

  function normalizeSupportedApifyActorId(value) {
    const candidate = text(value)
      .replace(/^https?:\/\/(?:console\.)?apify\.com\/actors\//i, '')
      .replace(/^\/+|\/+$/g, '')
      .replace('/', '~')
      .toLowerCase();
    return APIFY_ACTOR_IDS.find(actorId => actorId.toLowerCase() === candidate) || '';
  }

  function setApifyActorId(value) {
    const actorId = normalizeSupportedApifyActorId(value) || DEFAULT_APIFY_ACTOR_ID;
    if (B.apifyActorIdInput) B.apifyActorIdInput.value = actorId;
    save(STORE.apifyActorId, actorId);
    return actorId;
  }

  function getApifyActorId() {
    const currentValue = text(B.apifyActorIdInput?.value);
    const savedValue = load(STORE.apifyActorId, '');
    return setApifyActorId(currentValue || savedValue || DEFAULT_APIFY_ACTOR_ID);
  }

  function wireApifyActorIdInput() {
    if (!B.apifyActorIdInput) return;
    const savedValue = load(STORE.apifyActorId, '');
    setApifyActorId(savedValue || B.apifyActorIdInput.value || DEFAULT_APIFY_ACTOR_ID);
    B.apifyActorIdInput.addEventListener('change', () => {
      setApifyActorId(B.apifyActorIdInput.value);
    });
  }

  function getApifyToken() {
    const token = text(B.apifyApiTokenInput?.value);
    if (token) save(STORE.apifyToken, token);
    return token;
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function setClosedLoopRunning(value) {
    bridgeState.closedLoopRunning = !!value;
  }

  function isClosedLoopRunning() {
    return !!bridgeState.closedLoopRunning;
  }

  function setBridgeBusy(value) {
    bridgeState.bridgeBusy = !!value;
  }

  function isBridgeBusy() {
    return !!bridgeState.bridgeBusy;
  }

  function setActiveReadTab(tabId, link) {
    bridgeState.activeReadTabId = Number(tabId || 0) || null;
    bridgeState.activeReadLink = bridgeState.activeReadTabId ? String(link || '') : '';
  }

  function clearActiveReadTab() {
    bridgeState.activeReadTabId = null;
    bridgeState.activeReadLink = '';
  }

  function getActiveReadTabId() {
    return bridgeState.activeReadTabId;
  }

  function getActiveReadLink() {
    return bridgeState.activeReadLink;
  }

  window.fbBridgeShared = {
    $,
    B,
    STORE,
    save,
    load,
    text,
    clampNumber,
    getScanSourceMode,
    getGroupLimit,
    getLoopPauseSeconds,
    getLinkPauseSeconds,
    setBridgeStatus,
    reportProcess,
    getProcessStatus,
    addInputSave,
    parseLines,
    normalizeUrl,
    isGroupPermalinkUrl,
    uniqueLinks,
    getPostLinks,
    setPostLinks,
    getCommentedLinks,
    saveCommentedLink,
    renderCommentedLinks,
    getRemovedLinks,
    saveRemovedLink,
    renderRemovedLinks,
    filterLinksAgainstHistory,
    filterNewLinks,
    getPostCaptionMap,
    setPostCaptions,
    getPostCaption,
    removePostCaption,
    prunePostCaptions,
    syncPostLinksInput,
    updatePostLinkCounter,
    wirePostLinksInput,
    APIFY_ACTOR_IDS,
    setApifyActorId,
    getApifyActorId,
    wireApifyActorIdInput,
    getApifyToken,
    delay,
    setClosedLoopRunning,
    isClosedLoopRunning,
    setBridgeBusy,
    isBridgeBusy,
    setActiveReadTab,
    clearActiveReadTab,
    getActiveReadTabId,
    getActiveReadLink
  };
}());
