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

  function findFirstFieldString(value, fieldNames, depth = 0) {
    if (depth > 8 || value == null || typeof value !== 'object') return '';
    const wanted = new Set(fieldNames.map(name => String(name).replace(/[^a-z0-9]/gi, '').toLowerCase()));

    for (const [key, nestedValue] of Object.entries(value)) {
      const normalizedKey = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (wanted.has(normalizedKey) && ['string', 'number'].includes(typeof nestedValue)) {
        const result = text(nestedValue);
        if (result) return result;
      }
    }

    for (const nestedValue of Object.values(value)) {
      if (!nestedValue || typeof nestedValue !== 'object') continue;
      const result = findFirstFieldString(nestedValue, fieldNames, depth + 1);
      if (result) return result;
    }

    return '';
  }

  function extractGroupIdFromUrl(value) {
    const normalized = normalizeGroupUrl(value);
    const parsed = parseUrl(normalized);
    const match = parsed?.pathname.match(/^\/groups\/([^/?#]+)/i);
    return text(match?.[1]);
  }

  function extractPostIdFromUrl(value) {
    const parsed = parseUrl(value);
    if (!parsed || normalizeFacebookHost(parsed.hostname) !== 'www.facebook.com') return '';

    const pathname = parsed.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
    const pathMatch = pathname.match(/\/(?:posts|permalink)\/([^/?#]+)$/i);
    if (pathMatch?.[1]) return text(pathMatch[1]);

    return text(
      parsed.searchParams.get('story_fbid') ||
      parsed.searchParams.get('storyFbid') ||
      parsed.searchParams.get('multi_permalinks') ||
      parsed.searchParams.get('fbid')
    );
  }

  function buildGroupPermalink(groupId, postId) {
    const cleanGroupId = normalizePathSegment(groupId);
    const cleanPostId = normalizePathSegment(postId);
    if (!cleanGroupId || !cleanPostId) return '';
    return `https://www.facebook.com/groups/${cleanGroupId}/permalink/${cleanPostId}/`;
  }

  function extractCaptionFromItem(item) {
    return findFirstFieldString(item, [
      'caption',
      'post_caption',
      'postCaption'
    ]);
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

  function extractPostUrls(items, postUrlFieldValues = null, options = {}) {
    const links = [];
    const seen = new Set();
    const diagnostics = options?.diagnostics && typeof options.diagnostics === 'object'
      ? options.diagnostics
      : {};
    diagnostics.invalidPostUrlCount = 0;
    diagnostics.duplicatePostUrlCount = 0;
    diagnostics.reconstructedPostUrlCount = 0;
    diagnostics.postRecords = [];
    const fallbackGroupId = extractGroupIdFromUrl(options?.groupUrl);
    const recordByUrl = new Map();

    function addLink(value, item = null) {
      let link = normalizePostUrl(value);
      if (!link) {
        const postId = findFirstFieldString(item, [
          'post_id',
          'postId',
          'story_fbid',
          'storyFbid'
        ]) || extractPostIdFromUrl(value);
        const groupId = fallbackGroupId || findFirstFieldString(item, [
          'group_id',
          'groupId',
          'page_id',
          'pageId',
          'facebook_id',
          'facebookId'
        ]);
        link = buildGroupPermalink(groupId, postId);
        if (link) diagnostics.reconstructedPostUrlCount += 1;
      }
      if (!link) {
        diagnostics.invalidPostUrlCount += 1;
        return;
      }
      if (seen.has(link)) {
        diagnostics.duplicatePostUrlCount += 1;
        const existingRecord = recordByUrl.get(link);
        const duplicateCaption = extractCaptionFromItem(item);
        if (existingRecord && !existingRecord.caption && duplicateCaption) {
          existingRecord.caption = duplicateCaption;
        }
        return;
      }
      seen.add(link);
      links.push(link);
      const record = {
        url: link,
        caption: extractCaptionFromItem(item)
      };
      recordByUrl.set(link, record);
      diagnostics.postRecords.push(record);
    }

    // Luôn lấy toàn bộ giá trị của trường post_url/postUrl trong dataset trước.
    // Không dừng ở URL đầu tiên và không giới hạn số URL theo số lượng yêu cầu.
    const itemList = Array.isArray(items) ? items : [];
    for (const item of itemList) {
      const itemPostUrls = extractPostUrlFieldValues(item);
      if (itemPostUrls.length) {
        for (const value of itemPostUrls) addLink(value, item);
      } else {
        // Fallback cho Actor dùng tên trường URL khác post_url.
        addLink(extractPostUrlFromItem(item), item);
      }
    }

    if (!itemList.length) {
      const explicitPostUrls = Array.isArray(postUrlFieldValues)
        ? postUrlFieldValues
        : extractPostUrlFieldValues(items);
      for (const value of explicitPostUrls) addLink(value);
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

  function collectErrorCodes(error, output = new Set(), seen = new Set()) {
    if (!error || typeof error !== 'object' || seen.has(error)) return output;
    seen.add(error);

    const code = text(error.code);
    if (code) output.add(code);
    const status = Number(error.status || 0);
    if (status) output.add(`APIFY_HTTP_${status}`);

    for (const actorError of Array.isArray(error.actorErrors) ? error.actorErrors : []) {
      collectErrorCodes(actorError?.error || actorError, output, seen);
    }
    if (error.cause) collectErrorCodes(error.cause, output, seen);
    return output;
  }

  function classifyError(error) {
    const codes = [...collectErrorCodes(error)];
    const fatalCode = codes.find(code => [
      'APIFY_MODULE_MISSING',
      'APIFY_TOKEN_MISSING',
      'APIFY_ACTOR_ID_INVALID',
      'APIFY_GROUPS_EMPTY',
      'APIFY_HTTP_401',
      'APIFY_HTTP_402',
      'APIFY_HTTP_403'
    ].includes(code));

    if (fatalCode) {
      return {
        type: 'fatal',
        code: fatalCode,
        codes,
        message: error?.message || 'Cấu hình hoặc quyền truy cập Apify không hợp lệ.'
      };
    }

    const actorErrors = Array.isArray(error?.actorErrors) ? error.actorErrors : [];
    const allActorsHaveNoLinks = actorErrors.length > 0
      && actorErrors.every(item => text(item?.error?.code || item?.code) === 'APIFY_ACTOR_NO_POST_URLS');
    if (error?.noLinks === true || codes.includes('APIFY_NO_LINKS') || allActorsHaveNoLinks) {
      return {
        type: 'no_links',
        code: 'APIFY_NO_LINKS',
        codes,
        message: error?.message || 'Apify chạy thành công nhưng vòng này không có link bài viết.'
      };
    }

    return {
      type: 'retryable',
      code: codes[0] || 'APIFY_TEMPORARY_ERROR',
      codes,
      message: error?.message || 'Apify gặp lỗi tạm thời.'
    };
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
      const diagnostics = {};
      const links = extractPostUrls(items, postUrlFieldValues, { groupUrl, diagnostics });

      return {
        groupUrl,
        itemCount: items.length,
        postUrlFieldCount: postUrlFieldValues.length,
        reconstructedPostUrlCount: diagnostics.reconstructedPostUrlCount,
        invalidPostUrlCount: diagnostics.invalidPostUrlCount,
        duplicatePostUrlCount: diagnostics.duplicatePostUrlCount,
        captionCount: diagnostics.postRecords.filter(record => text(record.caption)).length,
        posts: diagnostics.postRecords,
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
    const postByUrl = new Map();

    for (let groupIndex = 0; groupIndex < groupUrls.length; groupIndex += 1) {
      const groupUrl = groupUrls[groupIndex];
      const notifyGroupProgress = async detail => {
        if (typeof options.onGroupProgress !== 'function') return;
        try {
          await options.onGroupProgress({
            actorId,
            actorLabel: getActorLabel(actorId),
            groupUrl,
            groupIndex: groupIndex + 1,
            totalGroups: groupUrls.length,
            ...detail
          });
        } catch {}
      };

      await notifyGroupProgress({ phase: 'start' });
      let groupResult;
      try {
        groupResult = await fetchGroupPostUrls({
          actorId,
          token,
          groupUrl,
          perGroupLimit,
          sortBy
        });
        await notifyGroupProgress({
          phase: 'complete',
          itemCount: groupResult.itemCount,
          linkCount: groupResult.links.length,
          captionCount: groupResult.captionCount
        });
      } catch (error) {
        await notifyGroupProgress({
          phase: 'error',
          code: error?.code || 'APIFY_GROUP_ERROR',
          message: error?.message || String(error)
        });
        throw error;
      }

      groupResults.push(groupResult);
      items.push(...groupResult.items);

      for (const link of groupResult.links) {
        if (seenLinks.has(link)) continue;
        seenLinks.add(link);
        links.push(link);
      }

      for (const post of groupResult.posts || []) {
        const existingPost = postByUrl.get(post.url);
        if (!existingPost) {
          postByUrl.set(post.url, { url: post.url, caption: text(post.caption) });
        } else if (!existingPost.caption && text(post.caption)) {
          existingPost.caption = text(post.caption);
        }
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
      posts: [...postByUrl.values()],
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
          if (result.itemCount === 0) {
            return {
              ...result,
              preferredActorId: actorCandidates[0],
              switchedActor: actorId !== actorCandidates[0],
              actorErrors,
              noLinks: true,
              noLinksReason: 'empty_dataset'
            };
          }

          const error = new Error(
            `Actor ${getActorLabel(actorId)} trả ${result.itemCount} bản ghi nhưng không có post_url hợp lệ.`
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
        if (classifyError(error).type === 'fatal') {
          error.actorId = error.actorId || actorId;
          error.actorErrors = [...actorErrors];
          throw error;
        }
      }
    }

    const allActorsHaveNoLinks = actorErrors.length > 0
      && actorErrors.every(item => text(item?.error?.code) === 'APIFY_ACTOR_NO_POST_URLS');
    if (allActorsHaveNoLinks) {
      const selected = [...actorErrors].reverse().find(item => item?.error?.result);
      const result = selected?.error?.result;
      if (result) {
        return {
          ...result,
          actorId: selected.actorId,
          preferredActorId: actorCandidates[0],
          switchedActor: selected.actorId !== actorCandidates[0],
          actorErrors,
          noLinks: true,
          noLinksReason: 'no_valid_post_urls'
        };
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
    extractCaptionFromItem,
    extractPostUrls,
    resolveSortBy,
    fetchPostUrls,
    fetchPostUrlsWithFallback,
    collectErrorCodes,
    classifyError
  };
}());
