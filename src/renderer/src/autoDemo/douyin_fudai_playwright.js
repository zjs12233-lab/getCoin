const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SESSION_DIR = path.join(__dirname, 'douyin-session');
const CORE_SCRIPT_PATH = path.join(__dirname, 'douyin_fudai_core.js');
const ENTRANCE_URL = 'https://www.douyin.com';
const PAGE_LOG_PREFIX = '[douyin-fudai]';
const VIEWPORT = { width: 1440, height: 900 };
const LOCAL_CHROME_PATHS = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
];
const LOCAL_EDGE_PATHS = [
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
];
let pageSequence = 0;

function log(message) {
    const timeText = new Date().toLocaleString('zh-CN', { hour12: false });
    console.log(`[${timeText}] ${message}`);
}

function installPlaywrightEntry(options = {}) {
    if (window.top !== window) {
        return;
    }

    if (window.__douyinFudaiPlaywrightEntryLoaded) {
        return;
    }

    window.__douyinFudaiPlaywrightEntryLoaded = true;

    const entranceUrl = options.entranceUrl;
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
            console.error('[douyin-fudai] Core installer is missing in page context');
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
}

function installSingleTabGuard() {
    if (window.top !== window) {
        return;
    }

    if (window.__douyinFudaiSingleTabGuardInstalled) {
        return;
    }

    window.__douyinFudaiSingleTabGuardInstalled = true;

    const nativeOpen = window.open ? window.open.bind(window) : null;

    window.open = function patchedOpen(url, target, features) {
        const urlText = typeof url === 'string' ? url : '';
        if (urlText && /douyin\.com/.test(urlText)) {
            try {
                window.location.href = new URL(urlText, window.location.href).href;
                return window;
            } catch (_) {
                window.location.href = urlText;
                return window;
            }
        }

        if (nativeOpen) {
            return nativeOpen(url, target, features);
        }

        return null;
    };
}

function bindPageLogs(page) {
    if (page.__douyinFudaiLogBound) {
        return;
    }

    page.__douyinFudaiLogBound = true;
    page.__douyinFudaiPageId = page.__douyinFudaiPageId || ++pageSequence;
    page.on('console', (msg) => {
        const text = msg.text();
        if (text.includes(PAGE_LOG_PREFIX)) {
            console.log(`[page#${page.__douyinFudaiPageId}] ${text}`);
        }
    });
    page.on('pageerror', (error) => {
        console.error(`[douyin-fudai][page#${page.__douyinFudaiPageId}][pageerror] ${error?.message || error}`);
    });
    page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) {
            console.log(`[douyin-fudai][page#${page.__douyinFudaiPageId}] navigated: ${frame.url()}`);
        }
    });
}

async function preparePage(page) {
    bindPageLogs(page);
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(30000);
}

function resolveBrowserLaunchOptions() {
    for (const chromePath of LOCAL_CHROME_PATHS) {
        if (fs.existsSync(chromePath)) {
            return {
                executablePath: chromePath,
                logMessage: `Use local Chrome executable: ${chromePath}`
            };
        }
    }

    for (const edgePath of LOCAL_EDGE_PATHS) {
        if (fs.existsSync(edgePath)) {
            return {
                executablePath: edgePath,
                logMessage: `Use local Edge executable as fallback: ${edgePath}`
            };
        }
    }

    return {
        executablePath: undefined,
        logMessage: `Use Playwright bundled Chromium: ${chromium.executablePath()}`
    };
}

async function main() {
    fs.mkdirSync(SESSION_DIR, { recursive: true });

    log(`Launch browser with session dir: ${SESSION_DIR}`);
    const browserLaunchOptions = resolveBrowserLaunchOptions();
    log(browserLaunchOptions.logMessage);

    const context = await chromium.launchPersistentContext(SESSION_DIR, {
        executablePath: browserLaunchOptions.executablePath,
        headless: false,
        viewport: VIEWPORT,
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        args: [
            '--disable-blink-features=AutomationControlled',
            '--start-maximized'
        ]
    });

    await context.addInitScript({ path: CORE_SCRIPT_PATH });
    await context.addInitScript(installSingleTabGuard);
    await context.addInitScript(installPlaywrightEntry, {
        entranceUrl: ENTRANCE_URL
    });

    context.on('page', (page) => {
        preparePage(page).catch((error) => {
            console.error(`[douyin-fudai] Page init failed: ${error?.message || error}`);
        });
        page.bringToFront().catch(() => {
        });
        console.log('[douyin-fudai][page] detected a new page, bringing it to front');
    });

    const existingPages = context.pages();
    const page = existingPages[0] || await context.newPage();

    for (const extraPage of existingPages.slice(1)) {
        await extraPage.close().catch(() => {
        });
    }

    await preparePage(page);
    await page.bringToFront();

    log(`Open Douyin entry: ${ENTRANCE_URL}`);
    await page.goto(ENTRANCE_URL, { waitUntil: 'domcontentloaded' });
    log('Browser started. Entry layer is handling ready/retry, core handles business flow.');
    await page.waitForEvent('close', { timeout: 0 });
}

main().catch((error) => {
    console.error(`[douyin-fudai] Startup failed: ${error?.stack || error}`);
    process.exitCode = 1;
});
