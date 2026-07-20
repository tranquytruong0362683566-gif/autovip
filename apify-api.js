(function () {
  'use strict';

  const SUPPORTED_ACTORS = Object.freeze([
    Object.freeze({
      id: 'powerful_bachelor~facebook-group-scraper',
      label: 'powerful_bachelor/Facebook-Group-Scraper'
    }),
    Object.freeze({
      id: 'caprolok~facebook-groups-scraper',
      label: 'caprolok/facebook-groups-scraper'
    })
  ]);
  const DEFAULT_ACTOR_ID = 'caprolok~facebook-groups-scraper';
  const API_BASE_URL = 'https://api.apify.com/v2';
  const REQUEST_TIMEOUT_MS = 295000;

  const DIRECT_POST_URL_KEYS = [
    'postUrl',
    'postURL',
    'post_url',
    'postLink',
    'post_link',
    'permalink',
    'permalinkUrl',
    'permalink_url',
    'facebookPostUrl',
    'facebook_post_url',
    'url',
    'link'
  ];

  function text(value) {
    return String(value ?? '').trim();
  }

  function normalizeActorId(value) {
    let actorId = text(value) || DEFAULT_ACTOR_ID;

    actorId = actorId
      .replace(/^https?:\/\/(?:console\.)?apify\.com\/actors\//i, '')
      .replace(/^\/+|\/+$/g, '')
      .split(/[?#]/, 1)[0]
      .trim();

    const ownerActorMatch = actorId.match(/^([^/\s]+)\/([^/\s]+)$/);
    if (ownerActorMatch) actorId = `${ownerActorMatch[1]}~${ownerActorMatch[2]}`;

    if (!/^[A-Za-z0-9._-]+(?:~[A-Za-z0-9._-]+)?$/.test(actorId)) {
      const error = new Error('Apify Actor ID không hợp lệ. Hãy nhập dạng owner~actor, owner/actor hoặc Actor ID nội bộ.');
      error.code = 'APIFY_ACTOR_ID_INVALID';
      throw error;
    }

    const supportedActor = SUPPORTED_ACTORS.find(actor => actor.id.toLowerCase() === actorId.toLowerCase());
    return supportedActor?.id || actorId;
  }

  function getActorLabel(value) {
    const actorId = normalizeActorId(value);
    return SUPPORTED_ACTORS.find(actor => actor.id === actorId)?.label || actorId.replace('~', '/');
  }

  function getActorCandidates(preferredActorId) {
    let normalizedPreferred = '';
    try {
      normalizedPreferred = normalizeActorId(preferredActorId);
    } catch {}

    const preferred = SUPPORTED_ACTORS.some(actor => actor.id === normalizedPreferred)
      ? normalizedPreferred
      : DEFAULT_ACTOR_ID;

    return [
      preferred,
      ...SUPPORTED_ACTORS.map(actor => actor.id).filter(actorId => actorId !== preferred)
    ];
  }

  function normalizeFacebookHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    if (host === 'facebook.com' || /^(?:www|web|m|mbasic)\.facebook\.com$/.test(host)) {
      return 'www.facebook.com';
    }
    return host;
  }

  function parseUrl(value) {
    const raw = text(value).replace(/&amp;/gi, '&');
    if (!raw) return null;

    try {
      return new URL(raw);
    } catch {}

    if (/^(?:www\.|web\.|m\.|mbasic\.)?facebook\.com\//i.test(raw)) {
      try {
        return new URL(`https://${raw}`);
      } catch {}
    }

    return null;
  }

  function normalizeGroupUrl(value) {
    const raw = text(value);
    if (!raw) return '';

    const parsed = parseUrl(raw);
    if (parsed) {
      const host = normalizeFacebookHost(parsed.hostname);
      if (host !== 'www.facebook.com') return '';

      const match = parsed.pathname.match(/\/groups\/([^/?#]+)/i);
      if (!match?.[1]) return '';
      return `https://www.facebook.com/groups/${encodeURIComponent(decodeURIComponent(match[1]))}`;
    }

    const pathMatch = raw.match(/(?:^|\/)groups\/([^/?#\s]+)/i);
    const groupId = text(pathMatch?.[1] || raw).replace(/^@/, '');
    if (!/^[A-Za-z0-9._-]{2,200}$/.test(groupId)) return '';

    return `https://www.facebook.com/groups/${encodeURIComponent(groupId)}`;
  }

  function normalizePathSegment(value) {
    const raw = text(value);
    if (!raw) return '';
    try {
      return encodeURIComponent(decodeURIComponent(raw));
    } catch {
      return encodeURIComponent(raw);
    }
  }

  function extractGroupPostParts(url) {
    if (!(url instanceof URL)) return null;
    if (normalizeFacebookHost(url.hostname) !== 'www.facebook.com') return null;

    const pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
    const match = pathname.match(/^\/groups\/([^/?#]+)\/(?:posts|permalink)\/([^/?#]+)$/i);
    if (!match?.[1] || !match?.[2]) return null;

    const groupId = normalizePathSegment(match[1]);
    const postId = normalizePathSegment(match[2]);
    if (!groupId || !postId) return null;

    return { groupId, postId };
  }

  function isFacebookPostUrl(url) {
    return !!extractGroupPostParts(url);
  }

  function normalizePostUrl(value) {
    const url = parseUrl(value);
    if (!url) return '';

    url.hostname = normalizeFacebookHost(url.hostname);
    url.protocol = 'https:';
    url.hash = '';

    const parts = extractGroupPostParts(url);
    if (!parts) return '';

    return `https://www.facebook.com/groups/${parts.groupId}/permalink/${parts.postId}/`;
  }

  function collectUrlStrings(value, output, depth = 0) {
    if (depth > 7 || value == null) return;

    if (typeof value === 'string') {
      if (/facebook\.com\//i.test(value)) output.push(value);
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) collectUrlStrings(item, output, depth + 1);
      return;
    }

    if (typeof value !== 'object') return;

    for (const nestedValue of Object.values(value)) {
      collectUrlStrings(nestedValue, output, depth + 1);
    }
  }

  function collectStringValues(value, output, depth = 0) {
    if (depth > 10 || value == null) return;

    if (typeof value === 'string') {
      const clean = text(value);
      if (clean) output.push(clean);
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) collectStringValues(item, output, depth + 1);
      return;
    }

    if (typeof value !== 'object') return;
    for (const nestedValue of Object.values(value)) {
      collectStringValues(nestedValue, output, depth + 1);
    }
  }

  function isPostUrlFieldName(key) {
    return String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase() === 'posturl';
  }

  function extractPostUrlFieldValues(value) {
    const output = [];

    function visit(node, depth = 0) {
      if (depth > 10 || node == null) return;

      if (Array.isArray(node)) {
        for (const item of node) visit(item, depth + 1);
        return;
      }

      if (typeof node !== 'object') return;

      for (const [key, nestedValue] of Object.entries(node)) {
        if (isPostUrlFieldName(key)) {
          collectStringValues(nestedValue, output);
        }
        visit(nestedValue, depth + 1);
      }
    }

    visit(value);
    return output;
  }

  function extractPostUrlFromItem(item) {
    if (typeof item === 'string') return normalizePostUrl(item);
    if (!item || typeof item !== 'object') return '';

    for (const key of DIRECT_POST_URL_KEYS) {
      const normalized = normalizePostUrl(item[key]);
      if (normalized) return normalized;
    }

    for (const [key, value] of Object.entries(item)) {
      if (!/(?:post|permalink).*(?:url|link)|(?:url|link).*(?:post|permalink)/i.test(key)) continue;
      const normalized = normalizePostUrl(value);
      if (normalized) return normalized;
    }

    const candidates = [];
    collectUrlStrings(item, candidates);
    for (const candidate of candidates) {
      const normalized = normalizePostUrl(candidate);
      if (normalized) return normalized;
    }

    return '';
  }

  function extractPostUrls(items, postUrlFieldValues = null) {
    const links = [];
    const seen = new Set();

    function addLink(value) {
      const link = normalizePostUrl(value);
      if (!link || seen.has(link)) return;
      seen.add(link);
      links.push(link);
    }

    // Luôn lấy toàn bộ giá trị của trường post_url/postUrl trong dataset trước.
    // Không dừng ở URL đầu tiên và không giới hạn số URL theo số lượng yêu cầu.
    const explicitPostUrls = Array.isArray(postUrlFieldValues)
      ? postUrlFieldValues
      : extractPostUrlFieldValues(items);
    for (const value of explicitPostUrls) addLink(value);

    for (const item of Array.isArray(items) ? items : []) {
      // Fallback cho Actor dùng tên trường URL khác post_url.
      addLink(extractPostUrlFromItem(item));
    }

    return links;
  }

  function resolveSortBy(scanMode) {
    return String(scanMode || '').toLowerCase() === 'group_top'
      ? 'TOP_POSTS'
      : 'CHRONOLOGICAL';
  }

  function readErrorMessage(payload, status) {
    const message = text(
      payload?.error?.message ||
      payload?.error?.type ||
      payload?.message ||
      payload?.data?.message
    );

    if (message) return message;
    if (status === 401 || status === 403) return 'Apify token không hợp lệ hoặc không có quyền chạy Actor.';
    if (status === 402) return 'Tài khoản Apify chưa có gói hoặc không đủ số dư để chạy Actor.';
    if (status === 408) return 'Actor chạy quá 300 giây nên Apify đã ngắt yêu cầu đồng bộ.';
    if (status === 429) return 'Apify đang giới hạn số lượng yêu cầu. Hãy thử lại sau.';
    return `Apify trả về HTTP ${status}.`;
  }

  function extractItems(payload) {
    return Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.data?.items)
        ? payload.data.items
        : Array.isArray(payload?.items)
          ? payload.items
          : [];
  }

  async function fetchGroupPostUrls({ actorId, token, groupUrl, perGroupLimit, sortBy }) {
    const endpoint = new URL(`${API_BASE_URL}/actors/${encodeURIComponent(actorId)}/run-sync-get-dataset-items`);
    endpoint.searchParams.set('format', 'json');
    endpoint.searchParams.set('clean', 'true');
    endpoint.searchParams.set('timeout', '300');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(endpoint.toString(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({
          startUrls: [{ url: groupUrl }],
          maxResults: perGroupLimit,
          sortBy
        }),
        signal: controller.signal
      });

      const responseText = await response.text();
      let payload = null;
      try {
        payload = responseText ? JSON.parse(responseText) : null;
      } catch {
        payload = responseText;
      }

      if (!response.ok) {
        const error = new Error(readErrorMessage(payload, response.status));
        error.code = `APIFY_HTTP_${response.status}`;
        error.status = response.status;
        error.data = payload;
        error.groupUrl = groupUrl;
        throw error;
      }

      // perGroupLimit chỉ là số lượng yêu cầu gửi cho Actor qua maxResults.
      // Actor có thể trả nhiều bản ghi hơn con số yêu cầu, vì vậy phải giữ toàn
      // bộ dataset thực tế thay vì tiếp tục cắt ở query API hoặc phía trình duyệt.
      const items = extractItems(payload);
      const postUrlFieldValues = extractPostUrlFieldValues(items);
      const links = extractPostUrls(items, postUrlFieldValues);

      return {
        groupUrl,
        itemCount: items.length,
        postUrlFieldCount: postUrlFieldValues.length,
        links,
        items
      };
    } catch (error) {
      if (error?.name === 'AbortError') {
        const timeoutError = new Error(`Hết thời gian chờ Apify sau 295 giây cho nhóm ${groupUrl}.`);
        timeoutError.code = 'APIFY_TIMEOUT';
        timeoutError.groupUrl = groupUrl;
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function fetchPostUrls(options = {}) {
    const actorId = normalizeActorId(options.actorId);
    const token = text(options.token);
    if (!token) {
      const error = new Error('Chưa nhập Apify API token.');
      error.code = 'APIFY_TOKEN_MISSING';
      throw error;
    }

    const rawGroups = Array.isArray(options.groups) ? options.groups : [];
    const groupUrls = [...new Set(rawGroups.map(normalizeGroupUrl).filter(Boolean))];
    if (!groupUrls.length) {
      const error = new Error('Không có UID hoặc link nhóm Facebook công khai hợp lệ.');
      error.code = 'APIFY_GROUPS_EMPTY';
      throw error;
    }

    const perGroupLimit = Math.max(1, Math.min(50, Math.round(Number(options.limit) || 5)));
    const maxResults = Math.max(1, perGroupLimit * groupUrls.length);
    const sortBy = resolveSortBy(options.scanMode);

    const groupResults = [];
    const items = [];
    const links = [];
    const seenLinks = new Set();

    for (const groupUrl of groupUrls) {
      const groupResult = await fetchGroupPostUrls({
        actorId,
        token,
        groupUrl,
        perGroupLimit,
        sortBy
      });

      groupResults.push(groupResult);
      items.push(...groupResult.items);

      for (const link of groupResult.links) {
        if (seenLinks.has(link)) continue;
        seenLinks.add(link);
        links.push(link);
      }
    }

    return {
      actorId,
      groupUrls,
      perGroupLimit,
      maxResults,
      sortBy,
      itemCount: items.length,
      links,
      items,
      groupResults
    };
  }

  async function fetchPostUrlsWithFallback(options = {}) {
    const actorCandidates = getActorCandidates(options.actorId);
    const actorErrors = [];

    for (let index = 0; index < actorCandidates.length; index += 1) {
      const actorId = actorCandidates[index];
      if (typeof options.onActorAttempt === 'function') {
        await options.onActorAttempt({
          actorId,
          actorLabel: getActorLabel(actorId),
          attempt: index + 1,
          total: actorCandidates.length,
          previousError: actorErrors.at(-1)?.error || null
        });
      }

      try {
        const result = await fetchPostUrls({ ...options, actorId });
        if (!result.links.length) {
          const error = new Error(
            result.itemCount > 0
              ? `Actor ${getActorLabel(actorId)} trả ${result.itemCount} bản ghi nhưng không có post_url hợp lệ.`
              : `Actor ${getActorLabel(actorId)} không trả về bản ghi nào.`
          );
          error.code = 'APIFY_ACTOR_NO_POST_URLS';
          error.actorId = actorId;
          error.result = result;
          throw error;
        }

        return {
          ...result,
          preferredActorId: actorCandidates[0],
          switchedActor: actorId !== actorCandidates[0],
          actorErrors
        };
      } catch (error) {
        actorErrors.push({ actorId, error });
      }
    }

    const summary = actorErrors
      .map(({ actorId, error }) => `${getActorLabel(actorId)}: ${error?.message || error}`)
      .join(' | ');
    const error = new Error(`Cả hai Apify Actor đều không lấy được link. ${summary}`);
    error.code = 'APIFY_ALL_ACTORS_FAILED';
    error.actorErrors = actorErrors;
    throw error;
  }

  window.apifyGroupsApi = {
    SUPPORTED_ACTORS,
    DEFAULT_ACTOR_ID,
    normalizeActorId,
    getActorLabel,
    getActorCandidates,
    normalizeGroupUrl,
    normalizePostUrl,
    extractPostUrlFieldValues,
    extractPostUrls,
    resolveSortBy,
    fetchPostUrls,
    fetchPostUrlsWithFallback
  };
}());
