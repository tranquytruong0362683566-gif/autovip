(function () {
  'use strict';

  const WEB_ORIGIN = window.location.origin;
  const WEB_SOURCE = 'AUTOVIP_WEB';
  const EXTENSION_SOURCE = 'AUTOVIP_EXTENSION';
  const REQUEST_TYPE = 'AUTOVIP_BRIDGE_REQUEST';
  const RESPONSE_TYPE = 'AUTOVIP_BRIDGE_RESPONSE';
  const DISCOVER_TYPE = 'AUTOVIP_BRIDGE_DISCOVER';
  const STATUS_TYPE = 'AUTOVIP_BRIDGE_STATUS';

  const pendingRequests = new Map();
  const readyWaiters = new Set();
  let bridgeConnected = false;
  let bridgeStatusMessage = 'Đang dò Extension Autovip...';

  function createRequestId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function getBridgeTimeoutMs(action) {
    const name = String(action || '');
    if (/SCAN_GROUP|SCAN_LINK/i.test(name)) return 15 * 60 * 1000;
    if (/SHOPEE|CUSTOM_LINK|AFFILIATE/i.test(name)) return 3 * 60 * 1000;
    if (/COMMENT/i.test(name)) return 4 * 60 * 1000;
    if (/READ/i.test(name)) return 3 * 60 * 1000;
    return 60 * 1000;
  }

  function setBridgeConnectionState(connected, message = '') {
    bridgeConnected = Boolean(connected);
    bridgeStatusMessage = String(message || (bridgeConnected
      ? 'Extension đã tự liên kết với Web Autovip.'
      : 'Chưa phát hiện Extension Autovip.'));

    if (bridgeConnected) {
      for (const waiter of [...readyWaiters]) waiter.resolve(true);
      readyWaiters.clear();
    }

    window.dispatchEvent(new CustomEvent('autovip:bridge-status', {
      detail: {
        connected: bridgeConnected,
        message: bridgeStatusMessage
      }
    }));
  }

  function announceDiscovery() {
    window.postMessage({
      source: WEB_SOURCE,
      type: DISCOVER_TYPE,
      requestId: createRequestId()
    }, WEB_ORIGIN);
  }

  function waitForBridgeReady(timeoutMs = 1800) {
    if (bridgeConnected) return Promise.resolve(true);

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          readyWaiters.delete(waiter);
          resolve(true);
        }
      };

      const timer = setTimeout(() => {
        readyWaiters.delete(waiter);
        reject(new Error(bridgeStatusMessage || 'Chưa phát hiện Extension Autovip. Hãy cài hoặc tải lại extension rồi tải lại trang web.'));
      }, timeoutMs);

      readyWaiters.add(waiter);
      announceDiscovery();
    });
  }

  function normalizeBridgeResponse(response) {
    if (!response || typeof response !== 'object') throw new Error('Extension trả về rỗng.');

    const success = response.ok !== false && response.success !== false && !response.error;
    if (!success) {
      const error = new Error(response.error || response.message || 'Extension báo lỗi.');
      error.code = response.code || 'EXTENSION_ERROR';
      throw error;
    }

    return {
      ...response,
      ok: true,
      success: true,
      code: response.code || 'OK',
      message: response.message || '',
      data: response.data ?? response.payload ?? response.result ?? response
    };
  }

  function rejectAllPending(message) {
    for (const [requestId, entry] of pendingRequests.entries()) {
      clearTimeout(entry.timer);
      const error = new Error(message || 'Kết nối Extension đã bị ngắt.');
      error.code = 'BRIDGE_DISCONNECTED';
      entry.reject(error);
      pendingRequests.delete(requestId);
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== WEB_ORIGIN) return;
    const data = event.data;
    if (!data || data.source !== EXTENSION_SOURCE) return;

    if (data.type === STATUS_TYPE) {
      setBridgeConnectionState(Boolean(data.connected), data.message || '');
      if (!data.connected) rejectAllPending(data.message || 'Kết nối Extension đã bị ngắt.');
      return;
    }

    if (data.type !== RESPONSE_TYPE) return;

    const requestId = String(data.requestId || '').trim();
    const entry = pendingRequests.get(requestId);
    if (!entry) return;

    pendingRequests.delete(requestId);
    clearTimeout(entry.timer);
    try {
      entry.resolve(normalizeBridgeResponse(data.response));
    } catch (error) {
      entry.reject(error);
    }
  });

  async function sendRawBridge(action, payload = {}) {
    const cleanAction = String(action || '').trim();
    if (!cleanAction) throw new Error('Thiếu action gửi sang Extension.');

    await waitForBridgeReady();

    const requestId = createRequestId();
    const timeoutMs = getBridgeTimeoutMs(cleanAction);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        const error = new Error('Extension xử lý quá lâu hoặc chưa phản hồi.');
        error.code = 'BRIDGE_TIMEOUT';
        reject(error);
      }, timeoutMs);

      pendingRequests.set(requestId, { resolve, reject, timer });

      window.postMessage({
        source: WEB_SOURCE,
        type: REQUEST_TYPE,
        requestId,
        action: cleanAction,
        payload: payload && typeof payload === 'object' ? payload : {}
      }, WEB_ORIGIN);
    });
  }

  async function sendBridge(actions, payload = {}) {
    let lastError = null;
    for (const action of actions) {
      try {
        return await sendRawBridge(action, payload);
      } catch (error) {
        lastError = error;
        if (!/Receiving end does not exist|message port closed|port closed|port đã đóng|response was received|không phản hồi|rỗng|unknown|not found|không hỗ trợ|BRIDGE_DISCONNECTED/i.test(String(error.message || error))) break;
      }
    }
    throw lastError || new Error('Không gửi được lệnh sang extension.');
  }

  function bridgeResponseData(response) {
    return response?.payload || response?.data || response?.result || response || {};
  }

  function extractLinksFromResponse(response) {
    const S = window.fbBridgeShared;
    const data = bridgeResponseData(response);
    const raw = data?.links || data?.postLinks || data?.urls || data?.items || data;
    if (Array.isArray(raw)) return raw.map(item => typeof item === 'string' ? item : (item.url || item.link || item.href)).filter(Boolean);
    if (typeof raw === 'string') return S.parseLines(raw).filter(line => /^https?:\/\//i.test(line));
    return [];
  }

  function extractArticleFromResponse(response) {
    const S = window.fbBridgeShared;
    const data = bridgeResponseData(response);
    return S.text(
      data?.article ||
      data?.content ||
      data?.text ||
      data?.title ||
      data?.postText ||
      data?.message
    );
  }

  function bridgeAvailable() {
    return bridgeConnected;
  }

  function getBridgeStatus() {
    return {
      connected: bridgeConnected,
      message: bridgeStatusMessage
    };
  }

  window.fbBridgeApi = {
    sendBridge,
    sendRawBridge,
    bridgeResponseData,
    extractLinksFromResponse,
    extractArticleFromResponse,
    bridgeAvailable,
    getBridgeStatus
  };

  announceDiscovery();
  window.setTimeout(announceDiscovery, 250);
  window.setTimeout(announceDiscovery, 1000);
})();
