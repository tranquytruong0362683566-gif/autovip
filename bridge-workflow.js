(function () {
  'use strict';

  const S = window.fbBridgeShared;
  const API = window.fbBridgeApi;
  const APIFY = window.apifyGroupsApi;
  const B = S.B;
  let fatalStopMessage = '';

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

    S.setBridgeStatus(`Đang gọi Apify lấy URL ${modeLabel}, tối đa ${expectedMax} kết quả...`, 'warn');

    const result = await APIFY.fetchPostUrls({
      token,
      groups,
      limit: groupLimit,
      scanMode
    });

    const links = S.filterNewLinks(result.links);
    const existingLinks = S.getPostLinks();
    S.setPostLinks([...existingLinks, ...links]);
    const queuedLinks = S.getPostLinks();

    if (links.length) {
      S.setBridgeStatus(
        `Apify trả về ${result.itemCount} bản ghi, đã lấy ${links.length} URL bài viết mới và điền vào ô Link bài viết Facebook. Tổng hàng đợi hiện có ${queuedLinks.length} link.`,
        'ok'
      );
    } else if (result.itemCount > 0) {
      S.setBridgeStatus(
        `Apify trả về ${result.itemCount} bản ghi nhưng không tìm thấy URL bài viết mới hợp lệ hoặc tất cả link đã có trong log.`,
        'warn'
      );
    } else {
      S.setBridgeStatus('Apify chạy xong nhưng không trả về bài viết nào.', 'warn');
    }

    return links;
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
        delayMs: Number(B.fbDelayMs?.value || 5000),
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
    S.setBridgeStatus('Đang gửi bình luận sang tab Facebook...', 'warn');

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
        waitAfterSendMinMs: 7000,
        waitAfterSendMaxMs: 10000,
        closeAfterComment: !!B.closeAfterComment?.checked,
        closeAfter: !!B.closeAfterComment?.checked,
        activateTab: true,
        active: true
      }
    );

    const responseData = API.bridgeResponseData(response);
    if (responseData?.restrictionDetected || responseData?.fatalStop || responseData?.code === 'FACEBOOK_FEATURE_RESTRICTED') {
      fatalStopMessage = responseData.message || 'Facebook đang tạm giới hạn tính năng đăng bài/bình luận. Hệ thống đã dừng.';
      S.setClosedLoopRunning(false);
      B.stopClosedLoopBtn?.classList.add('hidden');
      S.setBridgeStatus(fatalStopMessage, 'error');
      const stopError = new Error(fatalStopMessage);
      stopError.stopClosedLoop = true;
      stopError.code = 'FACEBOOK_FEATURE_RESTRICTED';
      throw stopError;
    }

    if (tabId && (B.closeAfterComment?.checked !== false)) S.clearActiveReadTab();
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
            S.saveCommentedLink(link);
            S.setPostLinks(S.getPostLinks().filter(item => S.normalizeUrl(item) !== S.normalizeUrl(link)));
            continue;
          }

          if (B.autoCommentAfterGenerate?.checked !== false && comment) {
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
        S.setBridgeStatus(`Đang chạy vòng ${cycleIndex}...`, 'warn');
        await scanGroupLinksByApify();
        if (!S.isClosedLoopRunning()) break;

        const queuedLinks = S.getPostLinks();
        if (!queuedLinks.length) {
          S.setPostLinks([]);
          if (!S.isClosedLoopRunning()) break;
          await waitBeforeNextGroupScan(cycleIndex);
          cycleIndex += 1;
          continue;
        }

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
    S.addInputSave(B.extensionId, S.STORE.extensionId);
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

    B.apifyScanBtn?.addEventListener('click', () => runBridgeTask(() => scanGroupLinksByApify()).catch(error => S.setBridgeStatus(error.message || String(error), 'error')));
    B.scanGroupLinksBtn?.addEventListener('click', () => runBridgeTask(() => runClosedGroupLoop()).catch(error => S.setBridgeStatus(error.message || String(error), 'error')));
    B.autoWorkflowBtn?.addEventListener('click', () => runBridgeTask(() => autoWorkflow()).catch(error => S.setBridgeStatus(error.message || String(error), 'error')));
    B.commentCurrentTabBtn?.addEventListener('click', () => runBridgeTask(() => commentCurrentTab()).catch(error => S.setBridgeStatus(error.message || String(error), 'error')));
    B.stopClosedLoopBtn?.addEventListener('click', () => {
      S.setClosedLoopRunning(false);
      B.stopClosedLoopBtn.classList.add('hidden');
      S.setBridgeStatus('Đã dừng vòng lặp.', 'warn');
    });
    B.clearCommentedLinksBtn?.addEventListener('click', () => {
      if (!confirm('Xoá toàn bộ log link đã comment?')) return;
      S.save(S.STORE.commented, []);
      S.renderCommentedLinks();
      S.setBridgeStatus('Đã xoá log link đã comment.', 'ok');
    });
  }

  window.addEventListener('DOMContentLoaded', wireBridge);
  window.fbBridgeController = {
    scanGroupLinksByApify,
    runClosedGroupLoop,
    readFirstFacebookPost,
    autoWorkflow,
    commentCurrentTab
  };
}());
