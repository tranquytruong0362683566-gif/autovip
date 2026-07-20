(function () {
  'use strict';

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

    return actorId;
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

  function extractPostUrls(items) {
    const links = [];
    const seen = new Set();

    for (const item of Array.isArray(items) ? items : []) {
      const link = extractPostUrlFromItem(item);
      if (!link || seen.has(link)) continue;
      seen.add(link);
      links.push(link);
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
    endpoint.searchParams.set('limit', String(perGroupLimit));

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

      const items = extractItems(payload).slice(0, perGroupLimit);
      const links = extractPostUrls(items).slice(0, perGroupLimit);

      return {
        groupUrl,
        itemCount: items.length,
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

  window.apifyGroupsApi = {
    DEFAULT_ACTOR_ID,
    normalizeActorId,
    normalizeGroupUrl,
    normalizePostUrl,
    extractPostUrls,
    resolveSortBy,
    fetchPostUrls
  };
}());
