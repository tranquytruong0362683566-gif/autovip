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
  let facebookNameRequestPromise = null;
  let facebookNameRequestUid = '';
  const facebookNamesByUid = new Map();
  const facebookNameLastAttempt = new Map();

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

  function reportProcess(detail = {}) {
    if (typeof S.reportProcess === 'function') S.reportProcess(detail);
  }

  function queueProcessMeta(index = 0, total = 0) {
    const current = Math.max(0, Number(index) || 0);
    const size = Math.max(0, Number(total) || 0);
    return {
      index: current,
      total: size,
      remaining: size ? Math.max(0, size - current) : 0
    };
  }

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

  function cleanFacebookName(value) {
    const name = S.text(value).replace(/\s+/g, ' ');
    if (!name || /^\d+$/.test(name) || name.length > 120) return '';
    return name;
  }

  function extractFacebookName(data) {
    if (!data || typeof data !== 'object') return '';
    return cleanFacebookName(
      data.name
      || data.displayName
      || data.facebookName
      || data.profileName
      || data.account?.name
      || data.profile?.name
    );
  }

  function setFacebookHello(loggedIn, uid, name = '', status = '') {
    if (!B.facebookNameDisplay) return;
    const cleanUid = S.text(uid);
    const cleanName = cleanFacebookName(name) || facebookNamesByUid.get(cleanUid) || '';

    if (!loggedIn || !cleanUid) {
      B.facebookNameDisplay.textContent = 'Chưa đăng nhập Facebook';
      return;
    }

    if (cleanName) {
      B.facebookNameDisplay.textContent = cleanName;
      return;
    }

    B.facebookNameDisplay.textContent = status || 'Đang nhận diện tên Facebook...';
  }

  function requestFacebookAccountName(uid, { forceRefresh = false } = {}) {
    const cleanUid = S.text(uid);
    if (!cleanUid) return Promise.resolve('');

    const cachedName = facebookNamesByUid.get(cleanUid) || '';
    if (cachedName && !forceRefresh) {
      setFacebookHello(true, cleanUid, cachedName);
      return Promise.resolve(cachedName);
    }

    if (facebookNameRequestPromise && facebookNameRequestUid === cleanUid) {
      return facebookNameRequestPromise;
    }

    const lastAttempt = facebookNameLastAttempt.get(cleanUid) || 0;
    if (!forceRefresh && Date.now() - lastAttempt < 60000) return Promise.resolve('');

    facebookNameLastAttempt.set(cleanUid, Date.now());
    facebookNameRequestUid = cleanUid;
    setFacebookHello(true, cleanUid, '', 'Đang nhận diện tên Facebook...');

    facebookNameRequestPromise = (async () => {
      try {
        const response = await API.sendBridge(
          ['GET_FACEBOOK_ACCOUNT_NAME', 'GET_FB_ACCOUNT_NAME', 'FACEBOOK_ACCOUNT_NAME'],
          { uid: cleanUid, forceRefresh }
        );
        const data = API.bridgeResponseData(response);
        const responseUid = S.text(data.uid || cleanUid);
        const name = extractFacebookName(data);

        if (name && responseUid === cleanUid) {
          facebookNamesByUid.set(cleanUid, name);
          if (lastFacebookLoggedIn && lastFacebookUid === cleanUid) {
            setFacebookHello(true, cleanUid, name);
          }
          return name;
        }

        if (lastFacebookLoggedIn && lastFacebookUid === cleanUid) {
          setFacebookHello(true, cleanUid, '', 'Chưa nhận diện được tên Facebook');
        }
        return '';
      } catch {
        if (lastFacebookLoggedIn && lastFacebookUid === cleanUid) {
          setFacebookHello(true, cleanUid, '', 'Chưa nhận diện được tên Facebook');
        }
        return '';
      } finally {
        if (facebookNameRequestUid === cleanUid) {
          facebookNameRequestPromise = null;
          facebookNameRequestUid = '';
        }
      }
    })();

    return facebookNameRequestPromise;
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
      const name = extractFacebookName(data);
      renderFacebookAccount({ loggedIn, uid, name });
      updateKnownFacebookAccount(loggedIn, uid);
      if (loggedIn && uid) {
        if (!name) requestFacebookAccountName(uid).catch(() => {});
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
          if (!S.isBridgeBusy() && !S.isClosedLoopRunning() && !B.dashboardAutoRunBtn?.disabled) break;
          await S.delay(500);
        }

        if (S.isBridgeBusy() || S.isClosedLoopRunning() || B.dashboardAutoRunBtn?.disabled) {
          throw new Error('Không thể tự chạy lại vì tác vụ cũ chưa kết thúc.');
        }

        const account = await refreshFacebookAccount({ silent: true });
        if (!account?.loggedIn || !account?.uid) {
          throw new Error('UID mới không còn đăng nhập trước lúc chạy lại.');
        }

        S.setBridgeStatus(`Đã có UID ${uid || account.uid}. Đang tiếp tục Chạy Tự Động...`, 'ok');
        reportProcess({
          actionKey: 'automatic-restart',
          title: 'Tiếp tục chạy tự động bằng UID mới',
          detail: `UID ${uid || account.uid} đã sẵn sàng.`,
          status: 'running',
          stage: 'scan',
          source: 'Facebook Cookie',
          countdown: null,
          historyMessage: `UID ${uid || account.uid} sẵn sàng, tiếp tục chạy tự động`,
          historyTag: 'OK',
          historyLevel: 'ok'
        });
        B.dashboardAutoRunBtn?.click();
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

      const name = extractFacebookName(account);
      renderFacebookAccount({ loggedIn: true, uid: account.uid, name });
      updateKnownFacebookAccount(true, account.uid);
      if (!name) requestFacebookAccountName(account.uid).catch(() => {});
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
    setFacebookHello(loggedIn, cleanUid, name);
    if (B.facebookUidDisplay) {
      B.facebookUidDisplay.textContent = loggedIn && cleanUid
        ? cleanUid
        : (message || 'Chưa đăng nhập');
      B.facebookUidDisplay.title = loggedIn && cleanUid
        ? `UID Facebook đang đăng nhập: ${cleanUid}`
        : (message || 'Chưa phát hiện tài khoản Facebook đang đăng nhập.');
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
        const name = extractFacebookName(data);
        renderFacebookAccount({ loggedIn, uid, name });
        const transitionedToLoggedOut = updateKnownFacebookAccount(loggedIn, uid);
        if (loggedIn && uid && !name) requestFacebookAccountName(uid).catch(() => {});
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
    reportProcess({
      actionKey: `cycle-${cycleIndex}-account-check`,
      title: 'Kiểm tra tài khoản Facebook',
      detail: `Đang xác thực UID trước khi bắt đầu vòng ${cycleIndex}.`,
      status: 'running',
      stage: 'scan',
      cycle: cycleIndex,
      source: 'Extension',
      target: '',
      targetLabel: 'TÀI KHOẢN FACEBOOK',
      countdown: null,
      resetStats: true,
      historyMessage: `Vòng ${cycleIndex}: kiểm tra UID Facebook`,
      historyTag: 'RUNNING',
      historyLevel: 'running'
    });

    const account = await refreshFacebookAccount({ silent: true });
    if (!account) {
      const error = new Error('Không kiểm tra được UID Facebook từ Extension. Chưa lấy cookie để tránh mất dòng cookie khi kết nối lỗi.');
      error.code = 'FACEBOOK_ACCOUNT_CHECK_FAILED';
      throw error;
    }

    if (account?.loggedIn && account?.uid) {
      S.setBridgeStatus(`Vòng ${cycleIndex}: đã phát hiện UID ${account.uid}. Bắt đầu quét nhóm...`, 'ok');
      reportProcess({
        actionKey: `cycle-${cycleIndex}-account-ready`,
        title: 'Xác thực UID Facebook thành công',
        detail: `UID ${account.uid} đã đăng nhập và sẵn sàng quét nhóm.`,
        status: 'ok',
        stage: 'scan',
        cycle: cycleIndex,
        source: 'Extension',
        target: account.uid,
        targetLabel: 'UID ĐANG SỬ DỤNG',
        historyMessage: `Xác thực UID ${account.uid} thành công`,
        historyTag: 'OK',
        historyLevel: 'ok'
      });
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

  async function waitAfterLink(linkIndex, totalLinks, nextLink = '') {
    const seconds = S.getLinkPauseSeconds();
    if (seconds <= 0 || !S.isClosedLoopRunning()) return;

    const historyKey = `wait-link-${linkIndex}-${totalLinks}-${Date.now()}`;
    const cleanNextLink = S.normalizeUrl(nextLink) || S.text(nextLink);
    const endAt = Date.now() + seconds * 1000;
    while (S.isClosedLoopRunning() && Date.now() < endAt) {
      const remainMs = Math.max(0, endAt - Date.now());
      const remainSeconds = Math.ceil(remainMs / 1000);
      S.setBridgeStatus(`Đã chạy xong link ${linkIndex}/${totalLinks}. Đang nghỉ ${remainSeconds} giây rồi chạy link tiếp theo...`, 'warn');
      reportProcess({
        actionKey: `wait-link-${linkIndex}-${totalLinks}`,
        title: 'Nghỉ trước khi xử lý link tiếp theo',
        detail: `Đã hoàn tất link ${linkIndex}/${totalLinks}. Bộ đếm chỉ cập nhật tại dòng hiện tại.`,
        status: 'wait',
        stage: 'comment',
        ...queueProcessMeta(linkIndex, totalLinks),
        source: 'Hàng đợi',
        countdown: remainSeconds,
        countdownLabel: 'Chuyển sang link tiếp theo sau',
        historyMessage: `Đã xong link ${linkIndex}/${totalLinks} · chờ ${remainSeconds} giây trước link tiếp theo${cleanNextLink ? `: ${cleanNextLink}` : ''}`,
        historyTag: 'WAIT',
        historyLevel: 'warn',
        historyKey,
        historyMode: 'update'
      });
      await S.delay(Math.min(1000, Math.max(200, remainMs)));
    }

    if (S.isClosedLoopRunning()) {
      reportProcess({
        actionKey: `wait-link-${linkIndex}-${totalLinks}`,
        title: 'Bắt đầu xử lý link tiếp theo',
        detail: `Đã chờ đủ ${seconds} giây sau link ${linkIndex}/${totalLinks}.`,
        status: 'running',
        stage: 'scan',
        ...queueProcessMeta(linkIndex, totalLinks),
        source: 'Hàng đợi',
        target: cleanNextLink,
        targetLabel: 'LINK TIẾP THEO',
        countdown: 0,
        countdownLabel: 'Chuyển sang link tiếp theo sau',
        historyMessage: `Đã xong link ${linkIndex}/${totalLinks} · còn 0 giây · chuyển sang${cleanNextLink ? ` ${cleanNextLink}` : ' link tiếp theo'}`,
        historyTag: 'READY',
        historyLevel: 'ok',
        historyKey,
        historyMode: 'update'
      });
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
          reportProcess({
            actionKey: 'manual-rakko-preload',
            title: 'Rakko đang đọc nội dung bài viết',
            detail: `Đã đọc ${completed}/${queue.length} description từ danh sách quét thủ công.`,
            status: 'running',
            stage: 'scan',
            ...queueProcessMeta(completed, queue.length),
            source: 'Rakko API',
            target: link,
            targetLabel: 'LINK ĐANG ĐỌC',
            countdown: null
          });
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
    reportProcess({
      actionKey: 'manual-facebook-scan',
      title: 'Quét nhóm Facebook thủ công',
      detail: `${groups.length} nhóm · nguồn ${modeLabel} · tối đa ${groupLimit} link mỗi nhóm.`,
      status: 'running',
      stage: 'scan',
      index: 0,
      total: groups.length,
      remaining: groups.length,
      source: 'Facebook + Rakko',
      target: groups[0] || '',
      targetLabel: 'NHÓM ĐANG QUÉT',
      countdown: null,
      historyMessage: `Bắt đầu quét thủ công ${groups.length} nhóm Facebook`,
      historyTag: 'RUNNING',
      historyLevel: 'running'
    });

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
      reportProcess({
        actionKey: 'manual-facebook-scan-complete',
        title: 'Quét thủ công hoàn tất',
        detail: `Nạp ${links.length} link mới; Rakko đọc được ${rakko.saved}/${links.length} description.`,
        status: 'ok',
        stage: 'scan',
        index: links.length,
        total: links.length,
        remaining: 0,
        source: 'Facebook + Rakko',
        target: '',
        targetLabel: 'KẾT QUẢ QUÉT',
        historyMessage: `Quét thủ công hoàn tất, nạp ${links.length} link mới`,
        historyTag: 'OK',
        historyLevel: 'ok'
      });
    } else {
      S.setBridgeStatus(`Đã mở và quét xong tab Facebook nhưng không có link ${modeLabel} mới sau khi đối chiếu hai danh sách lịch sử.${historyText}`, 'warn');
      reportProcess({
        actionKey: 'manual-facebook-scan-empty',
        title: 'Quét thủ công không có link mới',
        detail: `Không còn link ${modeLabel} sau khi đối chiếu lịch sử.`,
        status: 'wait',
        stage: 'scan',
        index: 0,
        total: 0,
        remaining: 0,
        source: 'Facebook + Rakko',
        target: '',
        targetLabel: 'KẾT QUẢ QUÉT',
        historyMessage: 'Quét thủ công hoàn tất nhưng không có link mới',
        historyTag: 'IDLE',
        historyLevel: 'warn'
      });
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
    const apifyHistoryKey = `apify-request-${Date.now()}`;

    let result;
    try {
      result = await APIFY.fetchPostUrlsWithFallback({
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
          reportProcess({
            actionKey: `apify-actor-${attempt}`,
            title: `Kết nối ${actorLabel}`,
            detail: `${normalizedGroups.length} nhóm · yêu cầu ${groupLimit} bài/nhóm · Actor ${attempt}/${total}.`,
            status: 'running',
            stage: 'scan',
            index: 0,
            total: normalizedGroups.length,
            remaining: normalizedGroups.length,
            source: actorLabel,
            target: normalizedGroups[0] || '',
            targetLabel: 'NHÓM CHỜ QUÉT',
            countdown: null,
            historyMessage: `Đang chờ Apify (${actorLabel}) trả kết quả · Actor ${attempt}/${total} · ${normalizedGroups.length} nhóm · yêu cầu ${requestedTotal} bài`,
            historyTag: 'RUNNING',
            historyLevel: 'running',
            historyKey: apifyHistoryKey,
            historyMode: 'update'
          });
        },
        onGroupProgress: ({ phase, actorLabel, groupUrl, groupIndex, totalGroups, itemCount, linkCount, captionCount, message }) => {
          const completed = phase === 'complete';
          const failed = phase === 'error';
          reportProcess({
            actionKey: `apify-group-${groupIndex}-${phase}`,
            title: failed
              ? `Lỗi khi quét nhóm ${groupIndex}/${totalGroups}`
              : completed
                ? `Đã quét xong nhóm ${groupIndex}/${totalGroups}`
                : `Apify đang quét nhóm ${groupIndex}/${totalGroups}`,
            detail: failed
              ? (message || 'Actor không trả được dữ liệu nhóm hiện tại.')
              : completed
                ? `Nhận ${itemCount || 0} bản ghi · ${linkCount || 0} link · ${captionCount || 0} caption.`
                : `Đang chờ Actor phản hồi dữ liệu của nhóm hiện tại.`,
            status: failed ? 'error' : completed ? 'ok' : 'running',
            stage: 'scan',
            index: completed ? groupIndex : Math.max(0, groupIndex - 1),
            total: totalGroups,
            remaining: Math.max(0, totalGroups - (completed ? groupIndex : groupIndex - 1)),
            source: actorLabel,
            target: groupUrl,
            targetLabel: 'NHÓM ĐANG QUÉT',
            countdown: null,
            historyMessage: failed
              ? `Apify lỗi tại nhóm ${groupIndex}/${totalGroups}: ${groupUrl} · ${message || 'Không nhận được dữ liệu'}`
              : completed
                ? `Apify đã trả nhóm ${groupIndex}/${totalGroups}: ${groupUrl} · ${itemCount || 0} bản ghi · ${linkCount || 0} link · ${captionCount || 0} caption`
                : `Đang chờ Apify trả nhóm ${groupIndex}/${totalGroups}: ${groupUrl}`,
            historyTag: failed ? 'ERROR' : completed ? 'RUNNING' : 'RUNNING',
            historyLevel: failed ? 'error' : 'running',
            historyKey: apifyHistoryKey,
            historyMode: 'update'
          });
        }
      });
    } catch (error) {
      const classification = classifyApifyError(error);
      reportProcess({
        actionKey: 'api-link-scan-error',
        title: 'Lấy Link API thất bại',
        detail: `${classification.code}: ${classification.message}`,
        status: 'error',
        stage: 'scan',
        source: 'Apify API',
        target: '',
        targetLabel: 'LỖI API',
        countdown: null,
        historyMessage: `Apify thất bại · ${classification.code}: ${classification.message}`,
        historyTag: 'ERROR',
        historyLevel: 'error',
        historyKey: apifyHistoryKey,
        historyMode: 'update'
      });
      if (error && typeof error === 'object') error.autovipApifyHistoryReported = true;
      throw error;
    }
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
      reportProcess({
        actionKey: 'apify-link-scan-complete',
        title: 'Lấy Link API hoàn tất',
        detail: `${result.itemCount} bản ghi · ${postUrlFieldCount} post_url · giữ ${links.length} link mới · ${savedCaptionCount} caption.`,
        status: 'ok',
        stage: 'scan',
        index: 0,
        total: links.length,
        remaining: links.length,
        source: workingActorLabel,
        target: links[0] || '',
        targetLabel: 'LINK ĐẦU HÀNG ĐỢI',
        countdown: null,
        historyMessage: `Apify hoàn tất · ${result.itemCount} bản ghi · ${links.length} link mới · ${savedCaptionCount} caption · đã nạp vào Danh sách link bài viết Facebook`,
        historyTag: 'OK',
        historyLevel: 'ok',
        historyKey: apifyHistoryKey,
        historyMode: 'update'
      });
    } else if (result.noLinksReason === 'no_valid_post_urls') {
      S.setBridgeStatus(
        `Apify trả về ${result.itemCount} bản ghi nhưng cả hai Actor đều không có post_url hợp lệ. Vòng này được coi là không có link, hệ thống sẽ nghỉ rồi tự quét tiếp.${actorStatusText}`,
        'warn'
      );
      reportProcess({
        actionKey: 'apify-link-scan-invalid',
        title: 'Apify không trả post_url hợp lệ',
        detail: `Đã nhận ${result.itemCount} bản ghi nhưng không tạo được link hợp lệ.`,
        status: 'wait',
        stage: 'scan',
        index: 0,
        total: 0,
        remaining: 0,
        source: responseActorLabel,
        target: '',
        targetLabel: 'KẾT QUẢ API',
        countdown: null,
        historyMessage: 'Apify phản hồi nhưng không có post_url hợp lệ',
        historyTag: 'IDLE',
        historyLevel: 'warn',
        historyKey: apifyHistoryKey,
        historyMode: 'update'
      });
    } else if (result.itemCount > 0) {
      S.setBridgeStatus(
        `Apify trả về ${result.itemCount} bản ghi nhưng không còn URL /permalink/ mới sau khi đối chiếu hai danh sách lịch sử.${historyText}${actorStatusText}`,
        'warn'
      );
      reportProcess({
        actionKey: 'apify-link-scan-duplicate',
        title: 'Không có link mới sau khi lọc',
        detail: `${result.itemCount} bản ghi đã được đối chiếu với lịch sử bình luận và loại bỏ.`,
        status: 'wait',
        stage: 'scan',
        index: 0,
        total: 0,
        remaining: 0,
        source: responseActorLabel,
        target: '',
        targetLabel: 'KẾT QUẢ API',
        countdown: null,
        historyMessage: 'Dữ liệu Apify không còn link mới sau khi lọc',
        historyTag: 'IDLE',
        historyLevel: 'warn',
        historyKey: apifyHistoryKey,
        historyMode: 'update'
      });
    } else {
      S.setBridgeStatus(`Apify chạy thành công nhưng vòng này không có bài viết mới. Đây là trạng thái bình thường.${actorStatusText}`, 'warn');
      reportProcess({
        actionKey: 'apify-link-scan-empty',
        title: 'Apify chưa có bài viết mới',
        detail: 'Actor hoạt động bình thường; hàng đợi không có link mới.',
        status: 'wait',
        stage: 'scan',
        index: 0,
        total: 0,
        remaining: 0,
        source: responseActorLabel,
        target: '',
        targetLabel: 'KẾT QUẢ API',
        countdown: null,
        historyMessage: 'Apify hoạt động bình thường nhưng chưa có bài mới',
        historyTag: 'IDLE',
        historyLevel: 'warn',
        historyKey: apifyHistoryKey,
        historyMode: 'update'
      });
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
    reportProcess({
      actionKey: 'rakko-read-current-link',
      title: 'Rakko đang đọc nội dung bài viết',
      detail: 'Caption Apify đang rỗng; gọi Rakko API làm nguồn dự phòng.',
      status: 'running',
      stage: 'scan',
      source: 'Rakko API',
      target: link,
      targetLabel: 'LINK ĐANG ĐỌC',
      countdown: null,
      historyMessage: 'Caption rỗng, chuyển sang Rakko API',
      historyTag: 'RUNNING',
      historyLevel: 'running'
    });
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
    reportProcess({
      actionKey: 'rakko-read-current-link-complete',
      title: 'Rakko đã trả nội dung bài viết',
      detail: `${article.length} ký tự đã được nạp vào nội dung gốc.`,
      status: 'ok',
      stage: 'ai',
      source: 'Rakko API',
      target: link,
      targetLabel: 'LINK ĐANG XỬ LÝ',
      countdown: null,
      historyMessage: `Rakko đã nạp ${article.length} ký tự nội dung`,
      historyTag: 'OK',
      historyLevel: 'ok'
    });
    return article;
  }

  async function loadArticleForLink(link, { allowRakkoFallback = true } = {}) {
    const caption = S.getPostCaption(link);
    if (caption) {
      await closeActiveReadTabIfAny();
      const article = setArticleInputContent(caption);
      S.setBridgeStatus('Đã lấy caption từ Apify và điền vào ô Nội dung bài viết gốc; không gọi Rakko API.', 'ok');
      reportProcess({
        actionKey: 'load-apify-caption',
        title: 'Đã nạp caption từ kết quả Apify',
        detail: `${article.length} ký tự · không cần gọi lại API đọc bài.`,
        status: 'ok',
        stage: 'ai',
        source: 'Caption Apify',
        target: link,
        targetLabel: 'LINK ĐANG XỬ LÝ',
        countdown: null,
        historyMessage: 'Nạp caption Apify cho AI',
        historyTag: 'OK',
        historyLevel: 'ok'
      });
      return { article, source: 'cached_caption' };
    }

    if (!allowRakkoFallback) {
      const error = new Error('Apify không trả caption cho link này. Hệ thống đã bỏ qua link và không gọi Rakko API.');
      error.code = 'APIFY_CAPTION_MISSING';
      throw error;
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
    const cleanTargetLink = S.normalizeUrl(targetLink) || S.text(targetLink);
    const cleanComment = S.text(comment).replace(/\s+/g, ' ');
    const commentHistoryKey = `facebook-comment-${Date.now()}`;
    reportProcess({
      actionKey: 'facebook-comment-submit',
      title: 'Đang gửi bình luận lên Facebook',
      detail: 'Extension mở tab ẩn, tìm đúng ô bình luận, gửi nội dung và kiểm tra giới hạn trong 11 giây.',
      status: 'running',
      stage: 'comment',
      source: 'Facebook Extension',
      target: targetLink,
      targetLabel: 'LINK ĐANG BÌNH LUẬN',
      countdown: null,
      historyMessage: `Đang bình luận vào ${cleanTargetLink || 'link Facebook hiện tại'} · Nội dung: “${cleanComment}”`,
      historyTag: 'RUNNING',
      historyLevel: 'running',
      historyKey: commentHistoryKey,
      historyMode: 'update'
    });
    const activeTabId = S.getActiveReadTabId();
    const activeLink = S.getActiveReadLink();
    const tabId = activeTabId && S.normalizeUrl(activeLink) === S.normalizeUrl(targetLink) ? activeTabId : null;
    let response;
    try {
      response = await API.sendBridge(
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
    } catch (error) {
      reportProcess({
        actionKey: 'facebook-comment-error',
        title: 'Gửi bình luận Facebook thất bại',
        detail: error.message || String(error),
        status: 'error',
        stage: 'comment',
        source: 'Facebook Extension',
        target: cleanTargetLink,
        targetLabel: 'LINK GẶP LỖI',
        countdown: null,
        statDelta: { errors: 1 },
        historyMessage: `Gửi bình luận thất bại tại ${cleanTargetLink || 'link Facebook hiện tại'} · Nội dung: “${cleanComment}” · Lỗi: ${error.message || error}`,
        historyTag: 'ERROR',
        historyLevel: 'error',
        historyKey: commentHistoryKey,
        historyMode: 'update'
      });
      if (error && typeof error === 'object') error.autovipCommentHistoryReported = true;
      throw error;
    }

    const responseData = API.bridgeResponseData(response);
    if (isDeletedFacebookPostResult(response)) {
      S.clearActiveReadTab();
      S.saveRemovedLink(targetLink);
      S.setBridgeStatus('bài viết đã bị xóa', 'warn');
      reportProcess({
        actionKey: 'facebook-post-deleted',
        title: 'Bài viết đã bị xóa',
        detail: 'Link được chuyển sang danh sách loại bỏ và tiến trình chuyển bài tiếp theo.',
        status: 'next',
        stage: 'comment',
        source: 'Facebook Extension',
        target: targetLink,
        targetLabel: 'LINK ĐÃ LOẠI BỎ',
        countdown: null,
        statDelta: { skipped: 1 },
        historyMessage: `Không thể bình luận vì bài đã bị xóa: ${cleanTargetLink} · Nội dung dự kiến: “${cleanComment}”`,
        historyTag: 'NEXT',
        historyLevel: 'warn',
        historyKey: commentHistoryKey,
        historyMode: 'update'
      });
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
      reportProcess({
        actionKey: 'facebook-comment-restricted',
        title: 'Facebook giới hạn tính năng bình luận',
        detail: fatalStopMessage,
        status: 'error',
        stage: 'comment',
        source: 'Facebook Extension',
        target: targetLink,
        targetLabel: 'LINK GẶP LỖI',
        countdown: null,
        statDelta: { errors: 1 },
        historyMessage: `Facebook giới hạn bình luận tại ${cleanTargetLink} · Nội dung: “${cleanComment}”`,
        historyTag: 'ERROR',
        historyLevel: 'error',
        historyKey: commentHistoryKey,
        historyMode: 'update'
      });
      const stopError = new Error(fatalStopMessage);
      stopError.stopClosedLoop = true;
      stopError.code = 'FACEBOOK_FEATURE_RESTRICTED';
      throw stopError;
    }

    if (tabId && CLOSE_TAB_AFTER_COMMENT) S.clearActiveReadTab();
    S.setBridgeStatus('Đã gửi bình luận xong.', 'ok');
    reportProcess({
      actionKey: 'facebook-comment-success',
      title: 'Bình luận Facebook thành công',
      detail: 'Đã kiểm tra sau gửi, đóng tab và lưu link vào lịch sử thành công.',
      status: 'ok',
      stage: 'comment',
      source: 'Facebook Extension',
      target: targetLink,
      targetLabel: 'LINK ĐÃ BÌNH LUẬN',
      countdown: null,
      statDelta: { success: 1 },
      historyMessage: `Đã bình luận thành công vào ${cleanTargetLink || 'link Facebook hiện tại'} · Nội dung: “${cleanComment}”`,
      historyTag: 'OK',
      historyLevel: 'ok',
      historyKey: commentHistoryKey,
      historyMode: 'update'
    });
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

  async function autoWorkflow({ manageLoopState = true, allowRakkoFallback = true } = {}) {
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
          reportProcess({
            actionKey: `queue-link-${index + 1}`,
            title: `Bắt đầu xử lý link ${index + 1}/${queue.length}`,
            detail: 'Đang nạp nội dung bài viết trước khi gửi sang AI phân loại.',
            status: 'running',
            stage: 'scan',
            ...queueProcessMeta(index + 1, queue.length),
            source: S.getPostCaption(link) ? 'Caption Apify' : (allowRakkoFallback ? 'Rakko dự phòng' : 'Apify thiếu caption'),
            target: link,
            targetLabel: 'LINK ĐANG XỬ LÝ',
            countdown: null,
            historyMessage: `Bắt đầu xử lý link ${index + 1}/${queue.length}`,
            historyTag: 'RUNNING',
            historyLevel: 'running'
          });
          S.setPostLinks([link, ...S.getPostLinks().filter(item => S.normalizeUrl(item) !== S.normalizeUrl(link))]);
          await loadArticleForLink(link, { allowRakkoFallback });

          const controller = window.chatGPTApiController || {};
          if (!controller.generateComment) throw new Error('Chưa nạp được hàm gọi API ChatGPT.');
          reportProcess({
            actionKey: `ai-link-${index + 1}`,
            title: 'AI đang phân loại và tạo bình luận',
            detail: `Phân tích nội dung của link ${index + 1}/${queue.length} theo mẫu đang chọn.`,
            status: 'running',
            stage: 'ai',
            ...queueProcessMeta(index + 1, queue.length),
            source: 'ChatGPT API',
            target: link,
            targetLabel: 'LINK ĐANG PHÂN TÍCH',
            countdown: null,
            historyMessage: `AI bắt đầu phân tích link ${index + 1}/${queue.length}`,
            historyTag: 'RUNNING',
            historyLevel: 'running'
          });
          const comment = await controller.generateComment();

          if (isNextCommentResult(comment) || controller.isNextResult?.(comment)) {
            S.setBridgeStatus(`AI xác định link ${index + 1}/${queue.length} là bài người bán/cho thuê, đã bỏ qua và chuyển bài tiếp theo.`, 'warn');
            reportProcess({
              actionKey: `ai-next-${index + 1}`,
              title: 'AI loại bài không phù hợp',
              detail: `Link ${index + 1}/${queue.length} trả về (next) và được chuyển vào danh sách loại bỏ.`,
              status: 'next',
              stage: 'ai',
              ...queueProcessMeta(index + 1, queue.length),
              source: 'ChatGPT API',
              target: link,
              targetLabel: 'LINK ĐÃ BỎ QUA',
              countdown: null,
              statDelta: { skipped: 1 },
              historyMessage: `AI trả về NEXT cho link ${index + 1}/${queue.length}`,
              historyTag: 'NEXT',
              historyLevel: 'warn'
            });
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
          reportProcess({
            actionKey: `queue-link-error-${index + 1}`,
            title: `Lỗi khi xử lý link ${index + 1}/${queue.length}`,
            detail: error.message || String(error),
            status: 'error',
            stage: 'comment',
            ...queueProcessMeta(index + 1, queue.length),
            source: 'Tiến trình tự động',
            target: link,
            targetLabel: 'LINK GẶP LỖI',
            countdown: null,
            statDelta: error?.autovipCommentHistoryReported ? null : { errors: 1 },
            historyMessage: error?.autovipCommentHistoryReported ? '' : `Link ${index + 1}/${queue.length} gặp lỗi, chuyển link tiếp theo`,
            historyTag: 'ERROR',
            historyLevel: 'error'
          });
          S.setPostLinks(S.getPostLinks().filter(item => S.normalizeUrl(item) !== S.normalizeUrl(link)));
        }

        if (index < queue.length - 1) await waitAfterLink(index + 1, queue.length, queue[index + 1]);
      }
    } finally {
      if (manageLoopState) {
        S.setClosedLoopRunning(false);
        B.stopClosedLoopBtn?.classList.add('hidden');
      }
    }

    if (!S.getPostLinks().length) {
      S.setBridgeStatus('Đã xử lý hết link trong ô Link bài viết Facebook.', 'ok');
      reportProcess({
        actionKey: 'queue-complete',
        title: 'Hoàn tất toàn bộ hàng đợi',
        detail: `Đã xử lý xong ${queue.length} link của lượt hiện tại.`,
        status: 'ok',
        stage: 'comment',
        index: queue.length,
        total: queue.length,
        remaining: 0,
        source: 'Hàng đợi',
        target: '',
        targetLabel: 'HÀNG ĐỢI',
        countdown: null,
        historyMessage: `Hoàn tất hàng đợi ${queue.length} link`,
        historyTag: 'OK',
        historyLevel: 'ok'
      });
    }
  }

  async function waitBeforeNextGroupScan(cycleIndex, reason = '') {
    const seconds = S.getLoopPauseSeconds();
    const totalMs = seconds * 1000;
    const prefix = S.text(reason) || `Vòng ${cycleIndex} đã xong.`;
    const historyKey = `wait-cycle-${cycleIndex}-${Date.now()}`;
    if (totalMs <= 0) {
      S.setBridgeStatus(`${prefix} Nghỉ 0 giây, quét tiếp ngay...`, 'warn');
      reportProcess({
        actionKey: `wait-cycle-${cycleIndex}`,
        title: 'Chuyển sang vòng tiếp theo',
        detail: prefix,
        status: 'wait',
        stage: 'scan',
        cycle: cycleIndex,
        source: 'Vòng tự động',
        target: '',
        targetLabel: 'TRẠNG THÁI VÒNG',
        countdown: 0,
        countdownLabel: 'Quét vòng tiếp theo sau',
        historyMessage: `${prefix} Còn 0 giây · bắt đầu vòng ${cycleIndex + 1}`,
        historyTag: 'READY',
        historyLevel: 'ok',
        historyKey,
        historyMode: 'update'
      });
      await S.delay(500);
      return;
    }

    const endAt = Date.now() + totalMs;
    while (S.isClosedLoopRunning() && Date.now() < endAt) {
      const remainMs = Math.max(0, endAt - Date.now());
      const remainSeconds = Math.ceil(remainMs / 1000);
      S.setBridgeStatus(`${prefix} Đang nghỉ ${remainSeconds} giây rồi tự quét vòng tiếp theo...`, 'warn');
      reportProcess({
        actionKey: `wait-cycle-${cycleIndex}`,
        title: 'Nghỉ trước vòng quét tiếp theo',
        detail: prefix,
        status: 'wait',
        stage: 'scan',
        cycle: cycleIndex,
        source: 'Vòng tự động',
        target: '',
        targetLabel: 'TRẠNG THÁI VÒNG',
        countdown: remainSeconds,
        countdownLabel: 'Quét vòng tiếp theo sau',
        historyMessage: `${prefix} Chờ ${remainSeconds} giây trước vòng ${cycleIndex + 1}`,
        historyTag: 'WAIT',
        historyLevel: 'warn',
        historyKey,
        historyMode: 'update'
      });
      await S.delay(Math.min(1000, remainMs));
    }

    if (S.isClosedLoopRunning()) {
      reportProcess({
        actionKey: `wait-cycle-${cycleIndex}`,
        title: `Bắt đầu vòng tự động ${cycleIndex + 1}`,
        detail: prefix,
        status: 'running',
        stage: 'scan',
        cycle: cycleIndex,
        source: 'Vòng tự động',
        target: '',
        targetLabel: 'TRẠNG THÁI VÒNG',
        countdown: 0,
        countdownLabel: 'Quét vòng tiếp theo sau',
        historyMessage: `${prefix} Còn 0 giây · bắt đầu vòng ${cycleIndex + 1}`,
        historyTag: 'READY',
        historyLevel: 'ok',
        historyKey,
        historyMode: 'update'
      });
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
          reportProcess({
            actionKey: `cycle-${cycleIndex}-start`,
            title: `Khởi chạy vòng tự động ${cycleIndex}`,
            detail: 'Chuẩn bị kiểm tra UID và lấy dữ liệu bài viết mới từ Apify.',
            status: 'running',
            stage: 'scan',
            cycle: cycleIndex,
            index: 0,
            total: 0,
            remaining: 0,
            source: 'Vòng tự động',
            target: '',
            targetLabel: 'TRẠNG THÁI VÒNG',
            countdown: null,
            resetStats: true,
            historyMessage: `Bắt đầu vòng tự động ${cycleIndex}`,
            historyTag: 'RUNNING',
            historyLevel: 'running'
          });
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
            await autoWorkflow({ manageLoopState: false, allowRakkoFallback: false });
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
          reportProcess({
            actionKey: `cycle-${cycleIndex}-temporary-error`,
            title: `Vòng ${cycleIndex} gặp lỗi tạm thời`,
            detail: error.message || String(error),
            status: 'error',
            stage: 'scan',
            cycle: cycleIndex,
            source: 'Vòng tự động',
            target: '',
            targetLabel: 'LỖI TẠM THỜI',
            countdown: null,
            statDelta: { errors: 1 },
            historyMessage: `Vòng ${cycleIndex} gặp lỗi tạm thời, vẫn tiếp tục`,
            historyTag: 'ERROR',
            historyLevel: 'error'
          });
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
      reportProcess({
        actionKey: 'closed-loop-stopped',
        title: fatalStopMessage ? 'Vòng tự động đã dừng do lỗi' : 'Vòng tự động đã dừng',
        detail: fatalStopMessage || 'Tiến trình đã nhận lệnh dừng và kết thúc an toàn.',
        status: fatalStopMessage ? 'error' : 'stop',
        stage: 'scan',
        source: 'Vòng tự động',
        target: '',
        targetLabel: 'TRẠNG THÁI HỆ THỐNG',
        countdown: null,
        historyMessage: fatalStopMessage ? 'Vòng tự động dừng do lỗi nghiêm trọng' : 'Vòng tự động đã dừng',
        historyTag: fatalStopMessage ? 'ERROR' : 'STOP',
        historyLevel: fatalStopMessage ? 'error' : 'warn'
      });
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

    B.apifyScanBtn?.addEventListener('click', () => runBridgeTask(
      () => scanGroupLinksByExtension({ preloadRakko: true })
    ).catch(error => S.setBridgeStatus(error.message || String(error), 'error')));
    B.dashboardAutoRunBtn?.addEventListener('click', () => runBridgeTask(
      () => runClosedGroupLoop()
    ).catch(error => S.setBridgeStatus(error.message || String(error), 'error')));
    B.scanGroupLinksBtn?.addEventListener('click', () => runBridgeTask(
      () => scanGroupLinksByApify()
    ).catch(error => {
      const classification = classifyApifyError(error);
      S.setBridgeStatus(`Lấy Link API thất bại (${classification.code}): ${classification.message}`, 'error');
      if (error?.autovipApifyHistoryReported) return;
      reportProcess({
        actionKey: 'api-link-scan-error',
        title: 'Lấy Link API thất bại',
        detail: `${classification.code}: ${classification.message}`,
        status: 'error',
        stage: 'scan',
        source: 'Apify API',
        target: '',
        targetLabel: 'LỖI API',
        countdown: null,
        historyMessage: `Lấy Link API thất bại: ${classification.code}`,
        historyTag: 'ERROR',
        historyLevel: 'error'
      });
    }));
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
    loadArticleForLink,
    autoWorkflow,
    commentCurrentTab,
    refreshFacebookAccount,
    logoutFacebookAccount,
    ensureFacebookAccountBeforeCycle
  };
}());
