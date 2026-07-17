(function () {
  'use strict';

  const S = window.fbBridgeShared;

  function bridgeAvailable() {
    return !!(window.chrome && chrome.runtime && (chrome.runtime.connect || chrome.runtime.sendMessage));
  }

  function getBridgeTimeoutMs(action) {
    const name = String(action || '');
    if (/SCAN_GROUP|SCAN_LINK/i.test(name)) return 15 * 60 * 1000;
    if (/SHOPEE|CUSTOM_LINK|AFFILIATE/i.test(name)) return 3 * 60 * 1000;
    if (/COMMENT/i.test(name)) return 4 * 60 * 1000;
    if (/READ/i.test(name)) return 3 * 60 * 1000;
    return 60 * 1000;
  }

  function normalizeBridgeResponse(response) {
    if (!response) throw new Error('Extension trả về rỗng.');
    if (response.ok === false || response.error) throw new Error(response.error || response.message || 'Extension báo lỗi.');
    return response;
  }

  function sendRawBridgeByPort(extensionId, message, timeoutMs) {
    return new Promise((resolve, reject) => {
      let port;
      let done = false;
      const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

      const cleanup = () => {
        done = true;
        clearTimeout(timer);
        try { port?.disconnect(); } catch {}
      };

      const timer = setTimeout(() => {
        if (done) return;
        cleanup();
        reject(new Error('Extension xử lý quá lâu hoặc chưa phản hồi.'));
      }, timeoutMs);

      try {
        port = chrome.runtime.connect(extensionId, { name: 'fb-auto-commenter-bridge' });
        port.onMessage.addListener(response => {
          if (!response || response.requestId !== requestId) return;
          cleanup();
          try { resolve(normalizeBridgeResponse(response)); } catch (error) { reject(error); }
        });
        port.onDisconnect.addListener(() => {
          if (done) return;
          cleanup();
          const err = chrome.runtime.lastError;
          reject(new Error(err?.message || 'Extension port đã đóng trước khi có phản hồi.'));
        });
        port.postMessage({ ...message, requestId });
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  function sendRawBridgeByMessage(extensionId, message, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('Extension xử lý quá lâu hoặc chưa phản hồi.'));
      }, timeoutMs);

      try {
        chrome.runtime.sendMessage(extensionId, message, response => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const lastError = chrome.runtime.lastError;
          if (lastError) return reject(new Error(lastError.message || 'Extension không phản hồi.'));
          try { resolve(normalizeBridgeResponse(response)); } catch (error) { reject(error); }
        });
      } catch (error) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      }
    });
  }

  function sendRawBridge(action, payload = {}) {
    return new Promise(async (resolve, reject) => {
      const extensionId = S.getExtensionId();
      if (!extensionId) return reject(new Error('Chưa nhập Extension ID.'));
      if (!bridgeAvailable()) return reject(new Error('Không tìm thấy chrome.runtime. Hãy mở bằng Chrome và cài extension bridge.'));

      const message = {
        action,
        type: action,
        cmd: action,
        source: 'github-web',
        payload,
        ...payload
      };
      const timeoutMs = getBridgeTimeoutMs(action);

      try {
        if (chrome.runtime.connect) {
          return resolve(await sendRawBridgeByPort(extensionId, message, timeoutMs));
        }
        return resolve(await sendRawBridgeByMessage(extensionId, message, timeoutMs));
      } catch (portError) {
        if (!chrome.runtime.sendMessage) return reject(portError);
        try {
          return resolve(await sendRawBridgeByMessage(extensionId, message, timeoutMs));
        } catch (messageError) {
          reject(messageError || portError);
        }
      }
    });
  }

  async function sendBridge(actions, payload = {}) {
    let lastError = null;
    for (const action of actions) {
      try {
        return await sendRawBridge(action, payload);
      } catch (error) {
        lastError = error;
        if (!/Receiving end does not exist|message port closed|port closed|port đã đóng|response was received|không phản hồi|rỗng|unknown|not found|không hỗ trợ/i.test(String(error.message || error))) break;
      }
    }
    throw lastError || new Error('Không gửi được lệnh sang extension.');
  }

  function bridgeResponseData(response) {
    return response?.payload || response?.data || response?.result || response || {};
  }

  function extractLinksFromResponse(response) {
    const data = bridgeResponseData(response);
    const raw = data?.links || data?.postLinks || data?.urls || data?.items || data;
    if (Array.isArray(raw)) return raw.map(item => typeof item === 'string' ? item : (item.url || item.link || item.href)).filter(Boolean);
    if (typeof raw === 'string') return S.parseLines(raw).filter(line => /^https?:\/\//i.test(line));
    return [];
  }

  function extractArticleFromResponse(response) {
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

  window.fbBridgeApi = {
    sendBridge,
    sendRawBridge,
    bridgeResponseData,
    extractLinksFromResponse,
    extractArticleFromResponse
  };
}());
