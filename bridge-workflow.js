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

  function updateKnownFacebookAccount(loggedIn, uid) {
    const previousLoggedIn = lastFacebookLoggedIn;
    const wasInitialized = facebookAccountStateInitialized;
    lastFacebookLoggedIn = Boolean(loggedIn && S.text(uid));
    facebookAccountStateInitialized = true;
    return wasInitialized && previousLoggedIn && !lastFacebookLoggedIn;
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
        {}
      );
      const data = API.bridgeResponseData(response);
      const uid = S.text(data.uid || data.facebookUid || data.cUser);
      const loggedIn = data.loggedIn === true || Boolean(uid);
      renderFacebookAccount({ loggedIn, uid });
      updateKnownFacebookAccount(loggedIn, uid);
      if (loggedIn && uid) return { ...data, uid, loggedIn };
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

      renderFacebookAccount({ loggedIn: true, uid: account.uid });
      updateKnownFacebookAccount(true, account.uid);
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

  function renderFacebookAccount({ loggedIn = false, uid = '', message = '', error = false } = {}) {
    const cleanUid = S.text(uid);
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
          {}
        );
        const data = API.bridgeResponseData(response);
        const uid = S.text(data.uid || data.facebookUid || data.cUser);
        const loggedIn = data.loggedIn === true || Boolean(uid);
        renderFacebookAccount({ loggedIn, uid });
        const transitionedToLoggedOut = updateKnownFacebookAccount(loggedIn, uid);
        if (
          transitionedToLoggedOut
          && !facebookLogoutPromise
          && !facebookCookieRotationPromise
          && !S.isClosedLoopRunning()
          && !S.isBridgeBusy()
        ) {
          rotateFacebookCookieAfterLogout({ source: 'extension-status-change' }).catch(() => {});
        }
        return { ...data, uid, loggedIn };
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
      const error = new Error('Chưa có UID Facebook đăng nhập và ô Cookie Facebook trong Cài đặt nâng cao đang trống.');
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

  async function scanGroupLinksByExtension() {
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
    S.setBridgeStatus(`Đang dùng bộ quét của autogpt-main để lấy ${modeLabel}, tối đa ${groupLimit} link mỗi nhóm...`, 'warn');

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
        openInBackground: false,
        active: true,
        activateTab: true,
        closeAfter: true
      }
    );

    const filtered = S.filterLinksAgainstHistory(API.extractLinksFromResponse(response));
    const links = filtered.links;
    const existingLinks = S.getPostLinks();
    S.setPostLinks([...existingLinks, ...links]);
    const queuedLinks = S.getPostLinks();
    const historyText = filtered.duplicateHistoryCount
      ? ` Đã xóa ${filtered.duplicateHistoryCount} link trùng lịch sử (${filtered.duplicateCommented.length} đã bình luận, ${filtered.duplicateRemoved.length} đã loại bỏ).`
      : '';

    if (links.length) {
      S.setBridgeStatus(
        `Bộ quét Extension đã lấy ${links.length} link ${modeLabel} không trùng và hiển thị trong hàng đợi.${historyText} Tổng hàng đợi hiện có ${queuedLinks.length} link.`,
        'ok'
      );
    } else {
      S.setBridgeStatus(`Bộ quét Extension không có link ${modeLabel} mới sau khi đối chiếu hai danh sách lịch sử.${historyText}`, 'warn');
    }

    return links;
  }

  async function scanGroupLinksByApify() {
    if (!APIFY?.fetchPostUrls) throw new Error('Chưa nạp được module Apify API.');

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
      S.setBridgeStatus('Hãy nhập Apify API token trong Cài đặt nâng cao.', 'warn');
      B.apifyApiTokenInput?.focus();
      const error = new Error('Chưa nhập Apify API token trong Cài đặt nâng cao.');
      error.code = 'APIFY_TOKEN_MISSING';
      throw error;
    }

    const groupLimit = S.getGroupLimit();
    const scanMode = S.getScanSourceMode();
    const modeLabel = scanModeLabel(scanMode);
    const expectedMax = Math.min(1024, groupLimit * groups.length);

    S.setBridgeStatus(`Đang gọi Actor ${actorId} lấy URL ${modeLabel}, tối đa ${expectedMax} kết quả...`, 'warn');

    const result = await APIFY.fetchPostUrls({
      actorId,
      token,
      groups,
      limit: groupLimit,
      scanMode
    });

    const filtered = S.filterLinksAgainstHistory(result.links);
    const links = filtered.links;
    const existingLinks = S.getPostLinks();
    S.setPostLinks([...existingLinks, ...links]);
    const queuedLinks = S.getPostLinks();
    const historyText = filtered.duplicateHistoryCount
      ? ` Đã xóa ${filtered.duplicateHistoryCount} link trùng lịch sử (${filtered.duplicateCommented.length} đã bình luận, ${filtered.duplicateRemoved.length} đã loại bỏ).`
      : '';

    if (links.length) {
      S.setBridgeStatus(
        `Apify trả về ${result.itemCount} bản ghi, còn ${links.length} URL /permalink/ không trùng và đã hiển thị trong ô Link bài viết Facebook.${historyText} Tổng hàng đợi hiện có ${queuedLinks.length} link.`,
        'ok'
      );
    } else if (result.itemCount > 0) {
      S.setBridgeStatus(
        `Apify trả về ${result.itemCount} bản ghi nhưng không còn URL /permalink/ mới sau khi đối chiếu hai danh sách lịch sử.${historyText}`,
        'warn'
      );
    } else {
      S.setBridgeStatus('Apify chạy xong nhưng không trả về bài viết nào.', 'warn');
    }

    return links;
  }

  async function scanGroupLinks({ preferApify = true } = {}) {
    const token = S.getApifyToken();
    if (preferApify && token) {
      try {
        return await scanGroupLinksByApify();
      } catch (error) {
        S.setBridgeStatus(
          `Apify không lấy được URL (${error.message || error}). Đang chuyển sang bộ quét nhóm trực tiếp của autogpt-main...`,
          'warn'
        );
        return await scanGroupLinksByExtension();
      }
    }

    if (preferApify && !token) {
      S.setBridgeStatus('Chưa có Apify token. Hệ thống chuyển sang bộ quét nhóm trực tiếp của autogpt-main...', 'warn');
    }
    return await scanGroupLinksByExtension();
  }


  async function readFirstFacebookPost() {
    const link = S.getPostLinks()[0];
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

    if (B.articleInput) {
      B.articleInput.value = article;
      B.articleInput.dispatchEvent(new Event('input', { bubbles: true }));
    }

    S.setBridgeStatus('Đã lấy description từ Rakko API và điền vào ô nội dung gốc.', 'ok');
    return article;
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
    await commentToFacebook(S.getPostLinks()[0] || '', comment);
    if (S.getPostLinks()[0]) S.saveCommentedLink(S.getPostLinks()[0]);
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
          await readFirstFacebookPost();

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
            await commentToFacebook(link, comment);
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

  async function waitBeforeNextGroupScan(cycleIndex) {
    const seconds = S.getLoopPauseSeconds();
    const totalMs = seconds * 1000;
    if (totalMs <= 0) {
      S.setBridgeStatus(`Vòng ${cycleIndex} đã xong. Nghỉ 0 giây, quét tiếp ngay...`, 'warn');
      await S.delay(500);
      return;
    }

    const endAt = Date.now() + totalMs;
    while (S.isClosedLoopRunning() && Date.now() < endAt) {
      const remainMs = Math.max(0, endAt - Date.now());
      const remainSeconds = Math.ceil(remainMs / 1000);
      S.setBridgeStatus(`Vòng ${cycleIndex} đã xong. Đang nghỉ ${remainSeconds} giây rồi quét tiếp...`, 'warn');
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
        try {
          await ensureFacebookAccountBeforeCycle(cycleIndex);
        } catch (error) {
          fatalStopMessage = error.message || String(error);
          S.setClosedLoopRunning(false);
          S.setBridgeStatus(fatalStopMessage, 'error');
          break;
        }

        S.setBridgeStatus(`Đang chạy vòng ${cycleIndex}...`, 'warn');
        await scanGroupLinks({ preferApify: true });
        if (!S.isClosedLoopRunning()) break;

        const queuedLinks = S.getPostLinks();
        if (!queuedLinks.length) {
          S.setPostLinks([]);
          if (!S.isClosedLoopRunning()) break;
          await waitBeforeNextGroupScan(cycleIndex);
          cycleIndex += 1;
          continue;
        }

        S.setBridgeStatus(`Vòng ${cycleIndex}: đã lọc xong link. Đang đọc description của link đầu tiên ngay...`, 'warn');
        await autoWorkflow({ manageLoopState: false });

        if (!S.isClosedLoopRunning()) break;
        await waitBeforeNextGroupScan(cycleIndex);
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
    [B.apifyScanBtn, B.scanGroupLinksBtn, B.autoWorkflowBtn, B.commentCurrentTabBtn].forEach(btn => { if (btn) btn.disabled = true; });
    try {
      return await task();
    } finally {
      S.setBridgeBusy(false);
      [B.apifyScanBtn, B.scanGroupLinksBtn, B.autoWorkflowBtn, B.commentCurrentTabBtn].forEach(btn => { if (btn) btn.disabled = false; });
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
    S.addInputSave(B.apifyActorIdInput, S.STORE.apifyActorId);
    S.getApifyActorId();
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
    S.renderCommentedLinks();
    S.renderRemovedLinks();

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

    B.apifyScanBtn?.addEventListener('click', () => runBridgeTask(() => scanGroupLinks({ preferApify: true })).catch(error => S.setBridgeStatus(error.message || String(error), 'error')));
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
      S.renderCommentedLinks();
      S.setBridgeStatus('Đã xoá danh sách link đã bình luận thành công.', 'ok');
    });
    B.clearRemovedLinksBtn?.addEventListener('click', () => {
      if (!confirm('Xoá toàn bộ danh sách link đã loại bỏ?')) return;
      S.save(S.STORE.removed, []);
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
    autoWorkflow,
    commentCurrentTab,
    refreshFacebookAccount,
    logoutFacebookAccount,
    ensureFacebookAccountBeforeCycle
  };
}());
