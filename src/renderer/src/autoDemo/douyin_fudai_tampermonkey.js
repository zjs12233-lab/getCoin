/**
 * 油猴入口文件。
 * 只负责加载 core、等待页面可用并根据 core 返回结果安排重试。
 */

// ==UserScript==
// @name         douyin fudai tampermonkey entry
// @namespace    http://tampermonkey.net/
// @version      0.5.0
// @description  抖音福袋油猴入口，完整逻辑由 douyin_fudai_core.js 提供
// @match        https://www.douyin.com/*
// @match        https://live.douyin.com/*
// @noframes
// @grant        none
// @run-at       document-start
// @require      file:///D:/projectCode/auto_douyin_wallet/douyin_fudai_core.js
// ==/UserScript==

(function () {
    if (window.__douyinFudaiTampermonkeyEntryLoaded) {
        return;
    }

    window.__douyinFudaiTampermonkeyEntryLoaded = true;

    const entranceUrl = 'https://www.douyin.com/';
    let retryTimer = 0;

    function clearRetryTimer() {
        if (!retryTimer) {
            return;
        }

        clearTimeout(retryTimer);
        retryTimer = 0;
    }

    function scheduleRetry(result) {
        const delayMs = result?.retryDelayMs || 0;
        if (!result?.retryable || delayMs <= 0) {
            return;
        }

        clearRetryTimer();
        retryTimer = window.setTimeout(() => {
            retryTimer = 0;
            void run();
        }, delayMs);
    }

    async function run() {
        clearRetryTimer();

        if (typeof window.installDouyinFudaiAutomation !== 'function') {
            console.error('[douyin-fudai] 未找到 douyin_fudai_core.js 导出的 installDouyinFudaiAutomation');
            return;
        }

        const api = window.installDouyinFudaiAutomation({ entranceUrl });
        const result = await api.startFlow();
        scheduleRetry(result);
    }

    function startWhenReady() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                void run();
            }, { once: true });
            return;
        }

        void run();
    }

    startWhenReady();
})();
