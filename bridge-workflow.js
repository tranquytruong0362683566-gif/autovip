(function () {
  'use strict';

  const S = window.fbBridgeShared;
  const API = window.fbBridgeApi;
  const APIFY = window.apifyGroupsApi;
  const B = S.B;
  const FACEBOOK_TAB_LOAD_DELAY_MS = 5000;
  const AUTO_COMMENT_AFTER_GENERATE = true;
  const CLOSE_TAB_AFTER_COMMENT = true;
  let fatalStopMessage = '';
  let facebookAccountRefreshPromise = null;
  let facebookLogoutPromise = null;
  let facebookCookieRotationPromise = null;
  let autoRestartScheduled = false;
  let facebookAccountStateInitialized = false;
  let lastFacebookLoggedIn = false;
  let lastFacebookUid = '';
  let facebookNameLookupPromise = null;
  let facebookNameLookupUid = '';
  const failedFacebookNameLookups = new Set();

  const CLOSED_LOOP_FATAL_CODES = new Set([
    'APIFY_MODULE_MISSING',
    'APIFY_TOKEN_MISSING',
    'APIFY_ACTOR_ID_INVALID',
    'APIFY_GROUPS_EMPTY',
    'APIFY_HTTP_401',
    'APIFY_HTTP_402',
    'APIFY_HTTP_403',
    'FACEBOOK_ACCOUNT_AND_COOKIE_MISSING',
    'FACEBOOK_FEATURE_RESTRICTED'
  ]);

  function classifyApifyError(error) {
    if (typeof APIFY?.classifyError === 'function') return APIFY.classifyError(error);
    return {
      type: CLOSED_LOOP_FATAL_CODES.has(S.text(error?.code)) ? 'fatal' : 'retryable',
      code: S.text(error?.code) || 'APIFY_TEMPORARY_ERROR',
      message: error?.message || String(error)
    };
  }

  function isFatalClosedLoopError(error) {
    if (error?.stopClosedLoop === true) return true;
    if (CLOSED_LOOP_FATAL_CODES.has(S.text(error?.code))) return true;
    return /^APIFY_/i.test(S.text(error?.code)) && classifyApifyError(error).type === 'fatal';
  }

  function markClosedLoopFatal(error) {
    const fatalError = error instanceof Error ? error : new Error(String(error || 'Lỗi nghiêm trọng.'));
    fatalError.stopClosedLoop = true;
    return fatalError;
  }

  function updateKnownFacebookAccount(loggedIn, uid) {
    const previousLoggedIn = lastFacebookLoggedIn;
    const wasInitialized = facebookAccountStateInitialized;
    const cleanUid = S.text(uid);
    lastFacebookLoggedIn = Boolean(loggedIn && cleanUid);
    lastFacebookUid = lastFacebookLoggedIn ? cleanUid : '';
    facebookAccountStateInitialized = true;
    return wasInitialized && previousLoggedIn && !lastFacebookLoggedIn;
  }

  function normalizeFacebookName(value) {
    const name = S.text(value).replace(/\s+/g, ' ');
    if (!name || /^\d+$/.test(name) || name.length > 120) return '';
    return name;
  }

  function extractFacebookName(data) {
    if (!data || typeof data !== 'object') return '';
    const candidates = [
      data.name,
      data.facebookName,
      data.profileName,
      data.displayName,
      data.fullName,
      data.accountName,
      data.account?.name,
      data.profile?.name,
      data.user?.name
    ];
    for (const candidate of candidates) {
      const name = normalizeFacebookName(candidate);
      if (name) return name;
    }
    return '';
  }

  function getCachedFacebookName(uid) {
    const cleanUid = S.text(uid);
    const cache = S.load(S.STORE.facebookProfileNames, {});
    if (!cleanUid || !cache || Array.isArray(cache) || typeof cache !== 'object') return '';
    return normalizeFacebookName(cache[cleanUid]);
  }

  function cacheFacebookName(uid, name) {
    const cleanUid = S.text(uid);
    const cleanName = normalizeFacebookName(name);
    if (!cleanUid || !cleanName) return '';
    const current = S.load(S.STORE.facebookProfileNames, {});
    const cache = current && !Array.isArray(current) && typeof current === 'object' ? current : {};
    cache[cleanUid] = cleanName;
    S.save(S.STORE.facebookProfileNames, cache);
    return cleanName;
  }

  async function resolveFacebookName(uid, accountData = {}) {
    const cleanUid = S.text(uid);
    if (!cleanUid) return '';

    const immediateName = extractFacebookName(accountData) || getCachedFacebookName(cleanUid);
    if (immediateName) return cacheFacebookName(cleanUid, immediateName);
    if (failedFacebookNameLookups.has(cleanUid)) return '';
    if (facebookNameLookupPromise && facebookNameLookupUid === cleanUid) return facebookNameLookupPromise;

    facebookNameLookupUid = cleanUid;
    facebookNameLookupPromise = (async () => {
      try {
        const response = await API.sendBridge(
          ['GET_FACEBOOK_PROFILE_NAME', 'GET_FB_PROFILE_NAME', 'RESOLVE_FACEBOOK_PROFILE_NAME'],
          {
            uid: cleanUid,
            profileUrl: `https://www.facebook.com/profile.php?id=${encodeURIComponent(cleanUid)}`
          }
        );
        const name = extractFacebookName(API.bridgeResponseData(response));
        if (name) return cacheFacebookName(cleanUid, name);
      } catch {}
      failedFacebookNameLookups.add(cleanUid);
      return '';
    })().finally(() => {
      if (facebookNameLookupUid === cleanUid) {
        facebookNameLookupPromise = null;
        facebookNameLookupUid = '';
      }
    });

    return facebookNameLookupPromise;
  }

  function requestFacebookName(uid, accountData = {}) {
    const cleanUid = S.text(uid);
    const immediateName = extractFacebookName(accountData) || getCachedFacebookName(cleanUid);
    if (immediateName) return immediateName;
    if (!cleanUid) return '';

    resolveFacebookName(cleanUid, accountData).then(name => {
      if (name && lastFacebookLoggedIn && lastFacebookUid === cleanUid) {
        renderFacebookAccount({ loggedIn: true, uid: cleanUid, name });
      }
    }).catch(() => {});
    return '';
  }

  function getFacebookCookieLines() {
    return String(B.facebookCookiesInput?.value || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
  }

  function takeNextFacebookCookie() {
    const lines = getFacebookCookieLines();
    const cookie = lines.shift() || '';
    if (B.facebookCookiesInput) B.facebookCookiesInput.value = lines.join('\n');
    S.save(S.STORE.facebookCookies, B.facebookCookiesInput?.value || '');
    return cookie;
  }

  async function waitForFacebookUid({ timeoutMs = 45000, intervalMs = 1000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const response = await API.sendBridge(
        ['GET_FACEBOOK_ACCOUNT', 'GET_FB_UID', 'FACEBOOK_ACCOUNT_STATUS'],
        { includeProfileName: true }
      );
      const data = API.bridgeResponseData(response);
      const uid = S.text(data.uid || data.facebookUid || data.cUser);
      const loggedIn = data.loggedIn === true || Boolean(uid);
      const name = extractFacebookName(data) || getCachedFacebookName(uid);
      renderFacebookAccount({ loggedIn, uid, name });
      updateKnownFacebookAccount(loggedIn, uid);
      if (loggedIn && uid) {
        if (!name) requestFacebookName(uid, data);
        return { ...data, uid, loggedIn, name };
      }
      await S.delay(intervalMs);
    }
    throw new Error('Quá thời gian chờ Extension cập nhật UID sau khi Login Cookie.');
  }

  function scheduleAutoRunByApi(uid) {
    if (autoRestartScheduled) return;
    autoRestartScheduled = true;

    (async () => {
      try {
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
          if (!S.isBridgeBusy() && !S.isClosedLoopRunning() && !B.scanGroupLinksBtn?.disabled) break;
          await S.delay(500);
        }

        if (S.isBridgeBusy() || S.isClosedLoopRunning() || B.scanGroupLinksBtn?.disabled) {
          throw new Error('Không thể tự chạy lại vì tác vụ cũ chưa kết thúc.');
        }

        const account = await refreshFacebookAccount({ silent: true });
        if (!account?.loggedIn || !account?.uid) {
          throw new Error('UID mới không còn đăng nhập trước lúc chạy lại.');
        }

        S.setBridgeStatus(`Đã có UID ${uid || account.uid}. Đang tự động bấm 🚀 Chạy tự động bằng API...`, 'ok');
        B.scanGroupLinksBtn?.click();
      } catch (error) {
        S.setBridgeStatus(`Không thể tự chạy lại bằng API: ${error.message || error}`, 'error');
      } finally {
        autoRestartScheduled = false;
      }
    })();
  }

  async function rotateFacebookCookieAfterLogout({ source = 'account-status', autoRestart = true } = {}) {
    if (facebookCookieRotationPromise) return facebookCookieRotationPromise;

    facebookCookieRotationPromise = (async () => {
      const cookie = takeNextFacebookCookie();
      if (!cookie) {
        S.setBridgeStatus('UID đã đăng xuất nhưng ô Cookie Facebook không còn dòng cookie nào để đăng nhập tiếp.', 'error');
        return null;
      }

      S.setBridgeStatus('UID đã đăng xuất. Đã lấy và xóa 1 dòng Cookie Facebook; đang gửi vào Login Cookie New của Extension...', 'warn');

      const response = await API.sendBridge(
        ['LOGIN_FACEBOOK_COOKIE', 'IMPORT_FACEBOOK_COOKIE', 'FB_LOGIN_COOKIE'],
        { cookie, cookieText: cookie, source }
      );
      const data = API.bridgeResponseData(response);
      const immediateUid = S.text(data.uid || data.facebookUid || data.cUser);
      const account = immediateUid
        ? { ...data, uid: immediateUid, loggedIn: true }
        : await waitForFacebookUid();

      const name = extractFacebookName(account) || getCachedFacebookName(account.uid);
      renderFacebookAccount({ loggedIn: true, uid: account.uid, name });
      updateKnownFacebookAccount(true, account.uid);
      if (!name) requestFacebookName(account.uid, account);
      S.setBridgeStatus(
        autoRestart
          ? `Login Cookie thành công. Đã phát hiện UID ${account.uid}; đang chuẩn bị chạy tự động bằng API...`
          : `Login Cookie thành công. Đã phát hiện UID ${account.uid}; tiếp tục vòng chạy hiện tại...`,
        'ok'
      );
      if (autoRestart) scheduleAutoRunByApi(account.uid);
      return account;
    })().catch(error => {
      S.setBridgeStatus(`Đăng nhập cookie tự động thất bại: ${error.message || error}`, 'error');
      throw error;
    }).finally(() => {
      facebookCookieRotationPromise = null;
    });

    return facebookCookieRotationPromise;
  }

  function renderFacebookAccount({ loggedIn = false, uid = '', name = '', message = '', error = false } = {}) {
    const cleanUid = S.text(uid);
    const cleanName = normalizeFacebookName(name) || getCachedFacebookName(cleanUid);
    if (B.facebookNameDisplay) {
      B.facebookNameDisplay.textContent = loggedIn && cleanUid
        ? (cleanName || 'Đang nhận diện tên Facebook...')
        : 'Chưa đăng nhập Facebook';
    }
    if (B.facebookUidDisplay) {
      B.facebookUidDisplay.textContent = message || (loggedIn && cleanUid
        ? `UID đang đăng nhập: ${cleanUid}`
        : 'Chưa phát hiện tài khoản Facebook đang đăng nhập.');
    }
    B.facebookAccountBar?.classList.toggle('logged-in', Boolean(loggedIn && cleanUid));
    B.facebookAccountBar?.classList.toggle('account-error', Boolean(error));
    if (B.facebookLogoutBtn) {
      B.facebookLogoutBtn.disabled = !loggedIn || !cleanUid || Boolean(facebookLogoutPromise);
    }
  }

  async function refreshFacebookAccount({ silent = false } = {}) {
    if (facebookAccountRefreshPromise) return facebookAccountRefreshPromise;

    facebookAccountRefreshPromise = (async () => {
      try {
        if (!silent) renderFacebookAccount({ message: 'Đang lấy UID từ Extension...' });
        const response = await API.sendBridge(
          ['GET_FACEBOOK_ACCOUNT', 'GET_FB_UID', 'FACEBOOK_ACCOUNT_STATUS'],
          { includeProfileName: true }
        );
        const data = API.bridgeResponseData(response);
        const uid = S.text(data.uid || data.facebookUid || data.cUser);
        const loggedIn = data.loggedIn === true || Boolean(uid);
        const name = extractFacebookName(data) || getCachedFacebookName(uid);
        renderFacebookAccount({ loggedIn, uid, name });
        const transitionedToLoggedOut = updateKnownFacebookAccount(loggedIn, uid);
        if (loggedIn && uid && !name) requestFacebookName(uid, data);
        if (
          transitionedToLoggedOut
          && !facebookLogoutPromise
          && !facebookCookieRotationPromise
          && !S.isClosedLoopRunning()
          && !S.isBridgeBusy()
        ) {
          rotateFacebookCookieAfterLogout({ source: 'extension-status-change' }).catch(() => {});
        }
        return { ...data, uid, loggedIn, name };
      } catch (error) {
        renderFacebookAccount({
          message: `Không lấy được UID từ Extension tự liên kết: ${error.message || error}`,
          error: true
        });
        if (!silent) S.setBridgeStatus(error.message || String(error), 'error');
        return null;
      } finally {
        facebookAccountRefreshPromise = null;
      }
    })();

    return facebookAccountRefreshPromise;
  }

  async function logoutFacebookAccount({ automatic = false, reason = '' } = {}) {
    if (facebookLogoutPromise) return facebookLogoutPromise;

    facebookLogoutPromise = (async () => {
      const oldText = B.facebookLogoutBtn?.textContent || 'Đăng xuất';
      if (B.facebookLogoutBtn) {
        B.facebookLogoutBtn.disabled = true;
        B.facebookLogoutBtn.textContent = automatic ? 'Đang tự đăng xuất...' : 'Đang đăng xuất...';
      }

      if (automatic) {
        S.setBridgeStatus(`${reason || 'Phát hiện lỗi giới hạn Facebook.'}
Đang tự động gọi nút Đăng xuất trên Extension...`, 'error');
      }

      try {
        const response = await API.sendBridge(
          ['LOGOUT_FACEBOOK', 'FB_LOGOUT', 'LOGOUT_FB_ACCOUNT'],
          { automatic, reason }
        );
        const data = API.bridgeResponseData(response);
        const previousUid = S.text(data.previousUid || data.uidBeforeLogout);
        const removedCookies = Number(data.removedCookies ?? data.removed ?? 0);

        renderFacebookAccount({
          loggedIn: false,
          uid: '',
          message: previousUid
            ? `Đã đăng xuất UID: ${previousUid}`
            : 'Đã đăng xuất tài khoản Facebook.'
        });
        updateKnownFacebookAccount(false, '');

        if (!automatic) {
          S.setBridgeStatus(`Đã đăng xuất Facebook và xóa ${removedCookies} cookie.`, 'ok');
        }

        try {
          await rotateFacebookCookieAfterLogout({
            source: automatic ? 'automatic-facebook-restriction' : 'web-logout-button'
          });
        } catch (_) {}
        return { ...data, previousUid, removedCookies };
      } catch (error) {
        await refreshFacebookAccount({ silent: true });
        if (!automatic) S.setBridgeStatus(`Đăng xuất Facebook thất bại: ${error.message || error}`, 'error');
        throw error;
      } finally {
        if (B.facebookLogoutBtn) B.facebookLogoutBtn.textContent = oldText;
        facebookLogoutPromise = null;
        if (B.facebookLogoutBtn) {
          B.facebookLogoutBtn.disabled = !B.facebookAccountBar?.classList.contains('logged-in');
        }
      }
    })();

    return facebookLogoutPromise;
  }

  async function ensureFacebookAccountBeforeCycle(cycleIndex = 1) {
    S.setBridgeStatus(`Vòng ${cycleIndex}: đang kiểm tra UID Facebook trước khi quét nhóm...`, 'warn');

    const account = await refreshFacebookAccount({ silent: true });
    if (!account) {
      const error = new Error('Không kiểm tra được UID Facebook từ Extension. Chưa lấy cookie để tránh mất dòng cookie khi kết nối lỗi.');
      error.code = 'FACEBOOK_ACCOUNT_CHECK_FAILED';
      throw error;
    }

    if (account?.loggedIn && account?.uid) {
      S.setBridgeStatus(`Vòng ${cycleIndex}: đã phát hiện UID ${account.uid}. Bắt đầu quét nhóm...`, 'ok');
      return account;
    }

    if (!getFacebookCookieLines().length) {
      const error = new Error('Chưa có UID Facebook đăng nhập và ô Cookie Facebook trong Cài Đặt WEB đang trống.');
      error.code = 'FACEBOOK_ACCOUNT_AND_COOKIE_MISSING';
      throw error;
    }

    S.setBridgeStatus(`Vòng ${cycleIndex}: chưa có UID đăng nhập. Đang lấy dòng Cookie Facebook đầu tiên để tự động đăng nhập...`, 'warn');
    const loggedInAccount = await rotateFacebookCookieAfterLogout({
      source: `automatic-cycle-${cycleIndex}`,
      autoRestart: false
    });

    if (!loggedInAccount?.loggedIn || !loggedInAccount?.uid) {
      const error = new Error('Đăng nhập Cookie Facebook xong nhưng chưa phát hiện được UID.');
      error.code = 'FACEBOOK_UID_NOT_DETECTED';
      throw error;
    }

    return loggedInAccount;
  }

  async function waitAfterLink(linkIndex, totalLinks) {
    const seconds = S.getLinkPauseSeconds();
    if (seconds <= 0 || !S.isClosedLoopRunning()) return;

    const endAt = Date.now() + seconds * 1000;
    while (S.isClosedLoopRunning() && Date.now() < endAt) {
      const remainMs = Math.max(0, endAt - Date.now());
      const remainSeconds = Math.ceil(remainMs / 1000);
      S.setBridgeStatus(`Đã chạy xong link ${linkIndex}/${totalLinks}. Đang nghỉ ${remainSeconds} giây rồi chạy link tiếp theo...`, 'warn');
      await S.delay(Math.min(1000, Math.max(200, remainMs)));
    }
  }

  function isNextCommentResult(value) {
    return /^\(?\s*next\s*\)?$/i.test(String(value || '').trim());
  }

  function isDeletedFacebookPostResult(response) {
    const data = API.bridgeResponseData(response);
    return data?.postDeleted === true
      || data?.code === 'FACEBOOK_POST_DELETED'
      || response?.code === 'FACEBOOK_POST_DELETED';
  }

  async function closeActiveReadTabIfAny() {
    const tabId = S.getActiveReadTabId();
    if (!tabId) return;
    try {
      await API.sendBridge(['CLOSE_FB_TAB', 'closeFbTab', 'CLOSE_TAB'], { tabId });
    } catch {}
    S.clearActiveReadTab();
  }

  function scanModeLabel(mode) {
    const labels = {
      group_latest: 'Bài viết mới',
      group_top: 'Bài viết Top'
    };
    return labels[mode] || labels.group_latest;
  }

  async function preloadRakkoCaptions(links) {
    const queue = Array.isArray(links) ? links.filter(Boolean) : [];
    if (!queue.length) {
      S.setPostCaptions([]);
      return { saved: 0, failed: 0 };
    }

    const records = [];
    const failed = [];
    let nextIndex = 0;
    let completed = 0;

    const worker = async () => {
      while (nextIndex < queue.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        const link = queue[currentIndex];
        try {
          const response = await API.sendBridge(
            ['READ_FB_POST_TITLE', 'READ_FB_POST', 'READ_FACEBOOK_POST', 'readFbPost', 'readFacebookPost', 'READ_POST'],
            {
              url: link,
              link,
              timeoutMs: 30000,
              useRakko: true,
              keepOpen: false,
              closeAfter: true
            }
          );
          const caption = API.extractArticleFromResponse(response);
          if (caption) records.push({ url: link, caption });
          else failed.push({ link, error: 'Rakko không trả description.' });
        } catch (error) {
          failed.push({ link, error: error?.message || String(error) });
        } finally {
          completed += 1;
          S.setBridgeStatus(
            `Đã quét link trên tab Facebook. Rakko đang đọc description ${completed}/${queue.length}...`,
            'warn'
          );
        }
      }
    };

    const workerCount = Math.min(2, queue.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    const saved = S.setPostCaptions(records);
    return { saved, failed: failed.length, failures: failed };
  }

  async function scanGroupLinksByExtension({ preloadRakko = true } = {}) {
    const groups = S.parseLines(B.fbGroupIdInput?.value);
    if (!groups.length) {
      S.setBridgeStatus('Hãy nhập UID hoặc link nhóm Facebook trước.', 'warn');
      B.fbGroupIdInput?.focus();
      const error = new Error('Chưa nhập UID hoặc link nhóm Facebook.');
      error.code = 'FACEBOOK_GROUPS_EMPTY';
      throw error;
    }

    const groupLimit = S.getGroupLimit();
    const scanMode = S.getScanSourceMode();
    const modeLabel = scanModeLabel(scanMode);
    S.setBridgeStatus(
      `Đang mở tab Facebook mới để quét thủ công ${modeLabel}, tối đa ${groupLimit} link mỗi nhóm...`,
      'warn'
    );

    const response = await API.sendBridge(
      ['SCAN_GROUP_PERMALINKS', 'SCAN_GROUP_LINKS', 'scanGroupLinks', 'SCAN_GROUP', 'scan_links', 'SCAN_LINKS'],
      {
        groups,
        groupIds: groups,
        scanMode,
        sourceMode: scanMode,
        feedMode: scanMode,
        limit: groupLimit,
        limitPerGroup: groupLimit,
        perGroupLimit: groupLimit,
        onlyPermalink: true,
        newestFirst: scanMode === 'group_latest',
        manualScan: true,
        scanStrategy: 'manual_tab_rakko',
        openInBackground: false,
        active: true,
        activateTab: true,
        closeAfter: true
      }
    );

    const filtered = S.filterLinksAgainstHistory(API.extractLinksFromResponse(response));
    const links = filtered.links;
    S.setPostCaptions([]);
    S.setPostLinks(links);
    const rakko = links.length && preloadRakko
      ? await preloadRakkoCaptions(links)
      : { saved: 0, failed: 0 };
    const queuedLinks = S.getPostLinks();
    const historyText = filtered.duplicateHistoryCount
      ? ` Đã xóa ${filtered.duplicateHistoryCount} link trùng lịch sử (${filtered.duplicateCommented.length} đã bình luận, ${filtered.duplicateRemoved.length} đã loại bỏ).`
      : '';

    if (links.length) {
      S.setBridgeStatus(
        `Quét thủ công đã mở tab Facebook mới và lấy ${links.length} link ${modeLabel} không trùng.${historyText} Rakko đã đọc được ${rakko.saved}/${links.length} description${rakko.failed ? `; ${rakko.failed} link sẽ tự gọi lại Rakko khi xử lý` : ''}. Hàng đợi hiện có ${queuedLinks.length} link.`,
        'ok'
      );
    } else {
      S.setBridgeStatus(`Đã mở và quét xong tab Facebook nhưng không có link ${modeLabel} mới sau khi đối chiếu hai danh sách lịch sử.${historyText}`, 'warn');
    }

    return links;
  }

  async function scanGroupLinksByApify() {
    if (!APIFY?.fetchPostUrls) {
      const error = new Error('Chưa nạp được module Apify API.');
      error.code = 'APIFY_MODULE_MISSING';
      throw error;
    }

    const groups = S.parseLines(B.fbGroupIdInput?.value);
    if (!groups.length) {
      S.setBridgeStatus('Hãy nhập UID hoặc link nhóm Facebook trước.', 'warn');
      B.fbGroupIdInput?.focus();
      const error = new Error('Chưa nhập UID hoặc link nhóm Facebook.');
      error.code = 'APIFY_GROUPS_EMPTY';
      throw error;
    }

    const actorId = S.getApifyActorId();
    const token = S.getApifyToken();
    if (!token) {
      S.setBridgeStatus('Hãy nhập Apify API token trong Cài Đặt API.', 'warn');
      B.apifyApiTokenInput?.focus();
      const error = new Error('Chưa nhập Apify API token trong Cài Đặt API.');
      error.code = 'APIFY_TOKEN_MISSING';
      throw error;
    }

    const groupLimit = S.getGroupLimit();
    const scanMode = S.getScanSourceMode();
    const modeLabel = scanModeLabel(scanMode);
    const normalizedGroups = [...new Set(groups.map(group => APIFY.normalizeGroupUrl(group)).filter(Boolean))];
    const requestedTotal = groupLimit * normalizedGroups.length;

    const result = await APIFY.fetchPostUrlsWithFallback({
      actorId,
      token,
      groups,
      limit: groupLimit,
      scanMode,
      onActorAttempt: ({ actorLabel, attempt, total, previousError }) => {
        const retryText = previousError
          ? ` Actor trước bị lỗi: ${previousError.message || previousError}. Đang tự chuyển Actor...`
          : '';
        S.setBridgeStatus(
          `${retryText} Đang gọi ${actorLabel} (${attempt}/${total}) theo ${normalizedGroups.length} lượt độc lập, yêu cầu ${groupLimit} bài mỗi nhóm (${requestedTotal} bài).`,
          'warn'
        );
      }
    });
    const groupResults = Array.isArray(result.groupResults) ? result.groupResults : [];
    const hasValidActorLinks = Array.isArray(result.links) && result.links.length > 0;
    const workingActorId = hasValidActorLinks ? S.setApifyActorId(result.actorId) : actorId;
    const workingActorLabel = APIFY.getActorLabel(workingActorId);
    const responseActorLabel = APIFY.getActorLabel(result.actorId || actorId);
    const actorStatusText = !hasValidActorLinks
      ? ` Actor ${responseActorLabel} đã phản hồi nhưng không có link hợp lệ; hệ thống giữ nguyên Actor đang chọn.`
      : (result.switchedActor
        ? ` Đã tự chuyển sang ${workingActorLabel} và lưu làm Actor mặc định cho lần chạy sau.`
        : ` Actor ${workingActorLabel} hoạt động và đã được lưu cho lần chạy sau.`);

    const filtered = S.filterLinksAgainstHistory(result.links);
    const links = filtered.links;
    const postUrlFieldCount = groupResults.reduce(
      (total, groupResult) => total + (Number(groupResult.postUrlFieldCount) || 0),
      0
    );
    const reconstructedPostUrlCount = groupResults.reduce(
      (total, groupResult) => total + (Number(groupResult.reconstructedPostUrlCount) || 0),
      0
    );
    const invalidPostUrlCount = groupResults.reduce(
      (total, groupResult) => total + (Number(groupResult.invalidPostUrlCount) || 0),
      0
    );
    const duplicatePostUrlCount = groupResults.reduce(
      (total, groupResult) => total + (Number(groupResult.duplicatePostUrlCount) || 0),
      0
    );
    const postUrlDetailText = ` Đã chuyển đổi ${reconstructedPostUrlCount} link định dạng khác; sai định dạng ${invalidPostUrlCount}; trùng trong kết quả Apify ${duplicatePostUrlCount}.`;
    const acceptedLinkKeys = new Set(links.map(S.normalizeUrl));
    const captionRecords = (Array.isArray(result.posts) ? result.posts : []).filter(post => acceptedLinkKeys.has(S.normalizeUrl(post.url)));
    const savedCaptionCount = S.setPostCaptions(captionRecords);
    S.setPostLinks(links);
    const queuedLinks = S.getPostLinks();
    const historyText = filtered.duplicateHistoryCount
      ? ` Đã xóa ${filtered.duplicateHistoryCount} link trùng lịch sử (${filtered.duplicateCommented.length} đã bình luận, ${filtered.duplicateRemoved.length} đã loại bỏ).`
      : '';

    if (links.length) {
      S.setBridgeStatus(
        `Apify đã quét riêng ${groupResults.length} nhóm theo nguồn ${modeLabel}, nhận ${result.itemCount} bản ghi, đọc ${postUrlFieldCount} giá trị post_url và giữ ${links.length} URL /permalink/ không trùng. Đã ghép ${savedCaptionCount}/${links.length} caption với đúng link.${postUrlDetailText}${historyText}${actorStatusText} Hàng đợi mới đã thay thế kết quả vòng trước và hiện có ${queuedLinks.length} link.`,
        'ok'
      );
    } else if (result.noLinksReason === 'no_valid_post_urls') {
      S.setBridgeStatus(
        `Apify trả về ${result.itemCount} bản ghi nhưng cả hai Actor đều không có post_url hợp lệ. Vòng này được coi là không có link, hệ thống sẽ nghỉ rồi tự quét tiếp.${actorStatusText}`,
        'warn'
      );
    } else if (result.itemCount > 0) {
      S.setBridgeStatus(
        `Apify trả về ${result.itemCount} bản ghi nhưng không còn URL /permalink/ mới sau khi đối chiếu hai danh sách lịch sử.${historyText}${actorStatusText}`,
        'warn'
      );
    } else {
      S.setBridgeStatus(`Apify chạy thành công nhưng vòng này không có bài viết mới. Đây là trạng thái bình thường.${actorStatusText}`, 'warn');
    }

    return links;
  }

  async function scanGroupLinks({ preferApify = true } = {}) {
    if (!preferApify) return await scanGroupLinksByExtension({ preloadRakko: true });

    try {
      return await scanGroupLinksByApify();
    } catch (error) {
      const classification = classifyApifyError(error);
      S.setPostCaptions([]);
      S.setPostLinks([]);

      if (classification.type === 'fatal') {
        S.setBridgeStatus(
          `Đã dừng vì lỗi cấu hình/xác thực Apify (${classification.code}): ${classification.message}`,
          'error'
        );
        throw markClosedLoopFatal(error);
      }

      if (classification.type === 'no_links') {
        S.setBridgeStatus('Apify chạy thành công nhưng vòng này không có link mới. Hệ thống sẽ nghỉ rồi tự quét vòng tiếp theo.', 'warn');
        return [];
      }

      S.setBridgeStatus(
        `Apify gặp lỗi tạm thời (${classification.code}): ${classification.message} Vòng hiện tại được bỏ qua; hệ thống sẽ nghỉ rồi tự thử lại, không dừng.`,
        'warn'
      );
      return [];
    }
  }


  function setArticleInputContent(article) {
    const content = S.text(article);
    if (!content) return '';
    if (B.articleInput) {
      B.articleInput.value = content;
      B.articleInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return content;
  }

  async function readFirstFacebookPost(targetLink = '') {
    const link = targetLink || S.getPostLinks()[0];
    if (!link) {
      S.setBridgeStatus('Chưa có link bài viết Facebook để đọc.', 'warn');
      B.fbPostLinkInput?.focus();
      return '';
    }

    S.setBridgeStatus('Đang gọi Rakko API lấy description bài viết...', 'warn');
    const response = await API.sendBridge(
      ['READ_FB_POST_TITLE', 'SCAN_FACEBOOK_POST', 'READ_FB_POST', 'READ_FACEBOOK_POST', 'readFbPost', 'readFacebookPost', 'READ_POST'],
      {
        url: link,
        link,
        delayMs: FACEBOOK_TAB_LOAD_DELAY_MS,
        maxChars: Number(B.fbMaxChars?.value || 20000),
        openInBackground: true,
        active: false,
        activateAfterAI: false,
        keepOpen: true,
        closeAfter: false,
        closeAfterRead: false,
        useFbPostLogic: true
      }
    );

    const data = API.bridgeResponseData(response);
    S.setActiveReadTab(Number(data.tabId || response.tabId || 0) || null, link);

    const article = API.extractArticleFromResponse(response);
    if (!article) throw new Error('Extension chưa trả về nội dung bài viết.');

    setArticleInputContent(article);

    S.setBridgeStatus('Đã lấy description từ Rakko API và điền vào ô nội dung gốc.', 'ok');
    return article;
  }

  async function loadArticleForLink(link) {
    const caption = S.getPostCaption(link);
    if (caption) {
      await closeActiveReadTabIfAny();
      const article = setArticleInputContent(caption);
      S.setBridgeStatus('Đã lấy nội dung đã ghép sẵn từ Apify/Rakko và điền vào ô Nội dung bài viết gốc; không gọi API đọc lại.', 'ok');
      return { article, source: 'cached_caption' };
    }

    S.setBridgeStatus('Nội dung ghép sẵn của link này đang rỗng. Đang gọi Rakko API làm dự phòng...', 'warn');
    const article = await readFirstFacebookPost(link);
    return { article, source: 'read_api_fallback' };
  }

  async function commentToFacebook(link, comment) {
    if (!comment) throw new Error('Chưa có nội dung bình luận.');
    if (isNextCommentResult(comment)) {
      S.setBridgeStatus('AI trả về (next), không gửi bình luận cho bài này.', 'warn');
      return { ok: true, skipped: true, reason: 'next' };
    }
    S.setBridgeStatus('Đang mở tab Facebook ẩn, chờ tải trang và gửi bình luận...', 'warn');

    const targetLink = link || S.getPostLinks()[0] || '';
    const activeTabId = S.getActiveReadTabId();
    const activeLink = S.getActiveReadLink();
    const tabId = activeTabId && S.normalizeUrl(activeLink) === S.normalizeUrl(targetLink) ? activeTabId : null;
    const response = await API.sendBridge(
      ['COMMENT_IN_FB_TAB', 'COMMENT_FB_POST', 'COMMENT_FACEBOOK_POST', 'commentFbPost', 'commentFacebookPost', 'COMMENT_POST', 'COMMENT_CURRENT_TAB'],
      {
        tabId,
        url: targetLink,
        link: targetLink,
        comment,
        text: comment,
        commentText: comment,
        waitAfterSendMinMs: 11000,
        waitAfterSendMaxMs: 11000,
        closeAfterComment: CLOSE_TAB_AFTER_COMMENT,
        closeAfter: CLOSE_TAB_AFTER_COMMENT,
        openInBackground: true,
        activateTab: false,
        active: false
      }
    );

    const responseData = API.bridgeResponseData(response);
    if (isDeletedFacebookPostResult(response)) {
      S.clearActiveReadTab();
      S.saveRemovedLink(targetLink);
      S.setBridgeStatus('bài viết đã bị xóa', 'warn');
      return response;
    }

    if (responseData?.restrictionDetected || responseData?.fatalStop || responseData?.code === 'FACEBOOK_FEATURE_RESTRICTED') {
      const restrictionMessage = responseData.message || 'Facebook đang tạm giới hạn tính năng đăng bài/bình luận. Hệ thống đã dừng.';
      S.setClosedLoopRunning(false);
      B.stopClosedLoopBtn?.classList.add('hidden');
      S.clearActiveReadTab();

      let logoutSuffix = '';
      try {
        const logoutResult = await logoutFacebookAccount({
          automatic: true,
          reason: restrictionMessage
        });
        logoutSuffix = logoutResult?.previousUid
          ? ` Đã tự động đăng xuất UID ${logoutResult.previousUid}.`
          : ' Đã tự động đăng xuất tài khoản Facebook.';
      } catch (logoutError) {
        logoutSuffix = ` Không thể tự động đăng xuất: ${logoutError.message || logoutError}.`;
      }

      fatalStopMessage = `${restrictionMessage}${logoutSuffix}`;
      S.setBridgeStatus(fatalStopMessage, 'error');
      const stopError = new Error(fatalStopMessage);
      stopError.stopClosedLoop = true;
      stopError.code = 'FACEBOOK_FEATURE_RESTRICTED';
      throw stopError;
    }

    if (tabId && CLOSE_TAB_AFTER_COMMENT) S.clearActiveReadTab();
    S.setBridgeStatus('Đã gửi bình luận xong.', 'ok');
    return response;
  }

  async function commentCurrentTab() {
    const comment = S.text(B.output?.textContent);
    if (!comment || /Bình luận sẽ xuất hiện/i.test(comment)) {
      S.setBridgeStatus('Chưa có bình luận để gửi.', 'warn');
      return;
    }
    if (isNextCommentResult(comment)) {
      S.setBridgeStatus('Kết quả là (next), không gửi bình luận.', 'warn');
      return;
    }
    const link = S.getPostLinks()[0] || '';
    const response = await commentToFacebook(link, comment);
    if (isDeletedFacebookPostResult(response)) return response;
    if (link) S.saveCommentedLink(link);
    return response;
  }

  async function autoWorkflow({ manageLoopState = true } = {}) {
    let links = S.getPostLinks();
    if (!links.length) {
      S.setBridgeStatus('Chưa có link bài viết. Hãy quét nhóm hoặc dán link trước.', 'warn');
      return;
    }

    if (manageLoopState) {
      await ensureFacebookAccountBeforeCycle(1);
      fatalStopMessage = '';
      S.setClosedLoopRunning(true);
      B.stopClosedLoopBtn?.classList.remove('hidden');
    }

    const queue = [...links];
    try {
      for (let index = 0; index < queue.length; index += 1) {
        const link = queue[index];
        if (!S.isClosedLoopRunning()) break;

        try {
          S.setBridgeStatus(`Đang xử lý link ${index + 1}/${queue.length}...`, 'warn');
          S.setPostLinks([link, ...S.getPostLinks().filter(item => S.normalizeUrl(item) !== S.normalizeUrl(link))]);
          await loadArticleForLink(link);

          const controller = window.chatGPTApiController || {};
          if (!controller.generateComment) throw new Error('Chưa nạp được hàm gọi API ChatGPT.');
          const comment = await controller.generateComment();

          if (isNextCommentResult(comment) || controller.isNextResult?.(comment)) {
            S.setBridgeStatus(`AI xác định link ${index + 1}/${queue.length} là bài người bán/cho thuê, đã bỏ qua và chuyển bài tiếp theo.`, 'warn');
            await closeActiveReadTabIfAny();
            S.saveRemovedLink(link);
            S.setPostLinks(S.getPostLinks().filter(item => S.normalizeUrl(item) !== S.normalizeUrl(link)));
            continue;
          }

          if (AUTO_COMMENT_AFTER_GENERATE && comment) {
            const commentResponse = await commentToFacebook(link, comment);
            if (isDeletedFacebookPostResult(commentResponse)) {
              // Bài đã bị xóa: link đã được chuyển sang danh sách loại bỏ.
              // Chuyển link kế tiếp ngay, không chạy waitAfterLink.
              continue;
            }
            S.saveCommentedLink(link);
            S.setPostLinks(S.getPostLinks().filter(item => S.normalizeUrl(item) !== S.normalizeUrl(link)));
          }
        } catch (error) {
          if (error?.stopClosedLoop || error?.code === 'FACEBOOK_FEATURE_RESTRICTED') {
            fatalStopMessage = error.message || fatalStopMessage || 'Facebook đang tạm giới hạn tính năng bình luận. Hệ thống đã dừng.';
            S.setClosedLoopRunning(false);
            B.stopClosedLoopBtn?.classList.add('hidden');
            S.setBridgeStatus(fatalStopMessage, 'error');
            break;
          }
          S.setBridgeStatus(`Lỗi ở link hiện tại, đã chuyển link kế tiếp:\n${error.message || error}`, 'error');
          S.setPostLinks(S.getPostLinks().filter(item => S.normalizeUrl(item) !== S.normalizeUrl(link)));
        }

        if (index < queue.length - 1) await waitAfterLink(index + 1, queue.length);
      }
    } finally {
      if (manageLoopState) {
        S.setClosedLoopRunning(false);
        B.stopClosedLoopBtn?.classList.add('hidden');
      }
    }

    if (!S.getPostLinks().length) {
      S.setBridgeStatus('Đã xử lý hết link trong ô Link bài viết Facebook.', 'ok');
    }
  }

  async function waitBeforeNextGroupScan(cycleIndex, reason = '') {
    const seconds = S.getLoopPauseSeconds();
    const totalMs = seconds * 1000;
    const prefix = S.text(reason) || `Vòng ${cycleIndex} đã xong.`;
    if (totalMs <= 0) {
      S.setBridgeStatus(`${prefix} Nghỉ 0 giây, quét tiếp ngay...`, 'warn');
      await S.delay(500);
      return;
    }

    const endAt = Date.now() + totalMs;
    while (S.isClosedLoopRunning() && Date.now() < endAt) {
      const remainMs = Math.max(0, endAt - Date.now());
      const remainSeconds = Math.ceil(remainMs / 1000);
      S.setBridgeStatus(`${prefix} Đang nghỉ ${remainSeconds} giây rồi tự quét vòng tiếp theo...`, 'warn');
      await S.delay(Math.min(1000, remainMs));
    }
  }

  async function runClosedGroupLoop() {
    if (S.isClosedLoopRunning()) return;

    fatalStopMessage = '';
    S.setClosedLoopRunning(true);
    B.stopClosedLoopBtn?.classList.remove('hidden');
    let cycleIndex = 1;

    try {
      while (S.isClosedLoopRunning()) {
        let waitReason = `Vòng ${cycleIndex} đã hoàn tất.`;
        try {
          await ensureFacebookAccountBeforeCycle(cycleIndex);
          S.setBridgeStatus(`Đang chạy vòng ${cycleIndex} bằng Apify API...`, 'warn');
          await scanGroupLinks({ preferApify: true });
          if (!S.isClosedLoopRunning()) break;

          const queuedLinks = S.getPostLinks();
          if (!queuedLinks.length) {
            S.setPostLinks([]);
            waitReason = `Vòng ${cycleIndex} không có link mới; đây là trạng thái bình thường.`;
          } else {
            S.setBridgeStatus(`Vòng ${cycleIndex}: đã lọc xong link. Đang nạp nội dung của link đầu tiên...`, 'warn');
            await autoWorkflow({ manageLoopState: false });
            waitReason = `Vòng ${cycleIndex} đã xử lý xong hàng đợi.`;
          }
        } catch (error) {
          if (isFatalClosedLoopError(error)) {
            fatalStopMessage = error.message || String(error);
            S.setClosedLoopRunning(false);
            S.setBridgeStatus(fatalStopMessage, 'error');
            break;
          }

          S.setPostCaptions([]);
          S.setPostLinks([]);
          waitReason = `Vòng ${cycleIndex} gặp lỗi tạm thời: ${error.message || error}. Tiến trình vẫn tiếp tục.`;
          S.setBridgeStatus(waitReason, 'warn');
        }

        if (!S.isClosedLoopRunning()) break;
        await waitBeforeNextGroupScan(cycleIndex, waitReason);
        cycleIndex += 1;
      }
    } finally {
      S.setClosedLoopRunning(false);
      B.stopClosedLoopBtn?.classList.add('hidden');
      if (fatalStopMessage) S.setBridgeStatus(fatalStopMessage, 'error');
      else S.setBridgeStatus('Vòng lặp đã dừng.', 'warn');
    }
  }

  async function runBridgeTask(task) {
    if (S.isBridgeBusy()) {
      S.setBridgeStatus('Đang có tác vụ chạy, vui lòng đợi tác vụ hiện tại hoàn tất.', 'warn');
      return;
    }
    S.setBridgeBusy(true);
    [B.dashboardAutoRunBtn, B.apifyScanBtn, B.scanGroupLinksBtn, B.autoWorkflowBtn, B.commentCurrentTabBtn].forEach(btn => { if (btn) btn.disabled = true; });
    try {
      return await task();
    } finally {
      S.setBridgeBusy(false);
      [B.dashboardAutoRunBtn, B.apifyScanBtn, B.scanGroupLinksBtn, B.autoWorkflowBtn, B.commentCurrentTabBtn].forEach(btn => { if (btn) btn.disabled = false; });
    }
  }

  function wireSecretToggle(input, toggle, label) {
    if (!input || !toggle) return;
    toggle.addEventListener('click', () => {
      const wasHidden = input.type === 'password';
      input.type = wasHidden ? 'text' : 'password';
      toggle.textContent = wasHidden ? '🙈' : '👁';
      toggle.setAttribute('aria-label', wasHidden ? `Ẩn ${label}` : `Hiện ${label}`);
      toggle.title = wasHidden ? `Ẩn ${label}` : `Hiện ${label}`;
    });
  }

  function wireBridge() {
    S.addInputSave(B.facebookCookiesInput, S.STORE.facebookCookies);
    S.wireApifyActorIdInput();
    S.addInputSave(B.apifyApiTokenInput, S.STORE.apifyToken);
    wireSecretToggle(B.apifyApiTokenInput, B.apifyApiTokenToggle, 'Apify token');
    S.addInputSave(B.fbGroupIdInput, S.STORE.groupIds);
    S.addInputSave(B.groupLimitInput, S.STORE.groupLimit);
    S.addInputSave(B.scanSourceModeSelect, S.STORE.scanSourceMode);
    S.addInputSave(B.loopPauseSecondsInput, S.STORE.loopPauseSeconds);
    if (B.loopPauseSecondsInput && !B.loopPauseSecondsInput.value) {
      const oldMinutes = S.load(S.STORE.oldLoopPauseMinutes, null);
      if (oldMinutes !== null && oldMinutes !== '') B.loopPauseSecondsInput.value = String(Math.round(S.clampNumber(oldMinutes, 5, 0, 1440)) * 60);
    }
    S.addInputSave(B.linkPauseSecondsInput, S.STORE.linkPauseSeconds);
    S.wirePostLinksInput();
    S.getScanSourceMode();
    S.getGroupLimit();
    S.getLoopPauseSeconds();
    S.getLinkPauseSeconds();
    S.wireHistoryInputs();

    B.facebookLogoutBtn?.addEventListener('click', () => {
      logoutFacebookAccount().catch(() => {});
    });
    window.addEventListener('focus', () => refreshFacebookAccount({ silent: true }));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshFacebookAccount({ silent: true });
    });
    window.setTimeout(() => refreshFacebookAccount({ silent: true }), 150);
    window.setInterval(() => {
      if (!document.hidden) refreshFacebookAccount({ silent: true });
    }, 2000);

    B.apifyScanBtn?.addEventListener('click', () => runBridgeTask(
      () => scanGroupLinksByExtension({ preloadRakko: true })
    ).catch(error => S.setBridgeStatus(error.message || String(error), 'error')));
    B.dashboardAutoRunBtn?.addEventListener('click', () => {
      if (!B.scanGroupLinksBtn || B.scanGroupLinksBtn.disabled) return;
      B.scanGroupLinksBtn.click();
    });
    B.scanGroupLinksBtn?.addEventListener('click', () => runBridgeTask(() => runClosedGroupLoop()).catch(error => S.setBridgeStatus(error.message || String(error), 'error')));
    B.autoWorkflowBtn?.addEventListener('click', () => runBridgeTask(() => autoWorkflow()).catch(error => S.setBridgeStatus(error.message || String(error), 'error')));
    B.commentCurrentTabBtn?.addEventListener('click', () => runBridgeTask(() => commentCurrentTab()).catch(error => S.setBridgeStatus(error.message || String(error), 'error')));
    B.stopClosedLoopBtn?.addEventListener('click', () => {
      S.setClosedLoopRunning(false);
      B.stopClosedLoopBtn.classList.add('hidden');
      S.setBridgeStatus('Đã dừng vòng lặp.', 'warn');
    });
    B.clearCommentedLinksBtn?.addEventListener('click', () => {
      if (!confirm('Xoá toàn bộ danh sách link đã bình luận thành công?')) return;
      S.save(S.STORE.commented, []);
      S.save(S.STORE.commentedText, '');
      S.renderCommentedLinks();
      S.setBridgeStatus('Đã xoá danh sách link đã bình luận thành công.', 'ok');
    });
    B.clearRemovedLinksBtn?.addEventListener('click', () => {
      if (!confirm('Xoá toàn bộ danh sách link đã loại bỏ?')) return;
      S.save(S.STORE.removed, []);
      S.save(S.STORE.removedText, '');
      S.renderRemovedLinks();
      S.setBridgeStatus('Đã xoá danh sách link đã loại bỏ.', 'ok');
    });
  }

  window.addEventListener('DOMContentLoaded', wireBridge);
  window.fbBridgeController = {
    scanGroupLinks,
    scanGroupLinksByExtension,
    scanGroupLinksByApify,
    runClosedGroupLoop,
    readFirstFacebookPost,
    loadArticleForLink,
    autoWorkflow,
    commentCurrentTab,
    refreshFacebookAccount,
    logoutFacebookAccount,
    ensureFacebookAccountBeforeCycle
  };
}());
