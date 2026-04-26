import douyinFudaiCoreSource from '../renderer/src/douyin_fudai_core.js?raw'
import {
  PAGE_AGENT_EVENT_PREFIX,
  PAGE_AGENT_EVENT_TYPES
} from '../shared/automationProtocol'

const AUTOMATION_STORAGE_KEY = '__douyin_fudai_auto_run__'
const AUTOMATION_OPTIONS_KEY = '__douyin_fudai_options__'
const FEED_ITEM_SELECTOR = '.page-recommend-container, [data-e2e="feed-item"]'
const DOUYIN_HOME_URLS = new Set(['https://www.douyin.com', 'https://www.douyin.com/jingxuan'])
const activeAutomationTasks = new Map()
const automationLogListeners = new Set()
const automationEventListeners = new Set()
const RUNTIME_SYNC_INTERVAL_MS = 2500
const BALANCE_SYNC_DELAY_MS = 1500
const BALANCE_SYNC_RETRY_DELAY_MS = 1500
const BALANCE_SYNC_MAX_ATTEMPTS = 3

function emitAutomationLog(payload = {}) {
  const entry = {
    time: new Date().toISOString(),
    level: payload.level || 'INFO',
    browserId: payload.browserId || '',
    message: payload.message || '',
    ...payload
  }

  for (const listener of automationLogListeners) {
    try {
      listener(entry)
    } catch (_) {
      // ignore listener failures
    }
  }
}

export function onAutomationLog(listener) {
  if (typeof listener !== 'function') {
    return () => {}
  }

  automationLogListeners.add(listener)
  return () => automationLogListeners.delete(listener)
}

function emitAutomationEvent(payload = {}) {
  const entry = {
    time: new Date().toISOString(),
    type: payload.type || PAGE_AGENT_EVENT_TYPES.STATUS,
    browserId: payload.browserId || '',
    payload: payload.payload || {},
    ...payload
  }

  for (const listener of automationEventListeners) {
    try {
      listener(entry)
    } catch (_) {
      // ignore listener failures
    }
  }
}

export function onAutomationEvent(listener) {
  if (typeof listener !== 'function') {
    return () => {}
  }

  automationEventListeners.add(listener)
  return () => automationEventListeners.delete(listener)
}

class CdpConnection {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.socket = null
    this.messageId = 0
    this.pendingMap = new Map()
    this.eventHandlers = new Map()
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(this.wsUrl)
      this.socket = socket

      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener(
        'error',
        (event) => {
          reject(new Error(`Failed to connect DevTools: ${event?.message || this.wsUrl}`))
        },
        { once: true }
      )

      socket.addEventListener('message', (event) => {
        try {
          const payload = JSON.parse(String(event.data || '{}'))

          if (payload.id) {
            const pending = this.pendingMap.get(payload.id)
            if (!pending) {
              return
            }

            this.pendingMap.delete(payload.id)

            if (payload.error) {
              pending.reject(new Error(payload.error.message || 'CDP request failed'))
              return
            }

            pending.resolve(payload.result)
            return
          }

          if (payload.method) {
            const handlers = this.eventHandlers.get(payload.method)
            if (!handlers?.size) {
              return
            }

            for (const handler of handlers) {
              try {
                handler(payload.params || {})
              } catch (_) {
                // ignore event handler failures
              }
            }
          }
        } catch (_) {
          // ignore malformed event payloads
        }
      })

      socket.addEventListener('close', () => {
        for (const [, pending] of this.pendingMap) {
          pending.reject(new Error('DevTools connection closed'))
        }
        this.pendingMap.clear()
      })
    })
  }

  on(method, handler) {
    if (!this.eventHandlers.has(method)) {
      this.eventHandlers.set(method, new Set())
    }

    this.eventHandlers.get(method).add(handler)
    return () => this.eventHandlers.get(method)?.delete(handler)
  }

  async send(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('DevTools connection is not open')
    }

    const id = ++this.messageId

    return await new Promise((resolve, reject) => {
      this.pendingMap.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    try {
      this.socket?.close()
    } catch (_) {
      // noop
    }
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeHttpBase(httpValue) {
  if (!httpValue) {
    throw new Error('BitBrowser did not return a remote-debugging http address')
  }

  return String(httpValue).startsWith('http') ? String(httpValue) : `http://${String(httpValue)}`
}

async function readJson(url) {
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`Failed to read remote debugging data: ${response.status}`)
  }

  return await response.json()
}

function isCandidateTarget(target) {
  const url = String(target?.url || '')

  if (target?.type !== 'page' || !target?.webSocketDebuggerUrl) {
    return false
  }

  return !url.startsWith('devtools://') && !url.startsWith('chrome://') && !url.startsWith('chrome-extension://')
}

function getUrlScore(url) {
  if (!url) {
    return -1
  }

  let score = 0

  if (url.includes('www.douyin.com/jingxuan')) {
    score += 120
  }

  if (url === 'https://www.douyin.com/' || url === 'https://www.douyin.com') {
    score += 110
  }

  if (url.includes('www.douyin.com')) {
    score += 90
  }

  if (url.includes('live.douyin.com')) {
    score += 70
  }

  return score
}

async function evaluateValue(wsUrl, expression, awaitPromise = true) {
  const client = new CdpConnection(wsUrl)

  try {
    await client.connect()
    const result = await client.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true
    })
    return result?.result?.value
  } finally {
    client.close()
  }
}

async function evaluateOnClient(client, expression, awaitPromise = true) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true
  })

  return result?.result?.value
}

function normalizeDouyinUrl(rawUrl = '') {
  try {
    const url = new URL(String(rawUrl))
    const normalizedPath = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')
    return `${url.origin}${normalizedPath}`
  } catch (_) {
    return String(rawUrl).replace(/\/+$/, '')
  }
}

function isDouyinHomeUrl(rawUrl = '') {
  return DOUYIN_HOME_URLS.has(normalizeDouyinUrl(rawUrl))
}

async function inspectTarget(target) {
  const fallback = {
    url: String(target?.url || ''),
    title: String(target?.title || ''),
    visibilityState: '',
    hasFocus: false
  }

  try {
    const value = await evaluateValue(
      target.webSocketDebuggerUrl,
      `(() => ({
        href: location.href,
        title: document.title,
        visibilityState: document.visibilityState,
        hasFocus: typeof document.hasFocus === 'function' ? document.hasFocus() : false
      }))()`
    )

    return {
      url: String(value?.href || fallback.url),
      title: String(value?.title || fallback.title),
      visibilityState: String(value?.visibilityState || ''),
      hasFocus: Boolean(value?.hasFocus)
    }
  } catch (_) {
    return fallback
  }
}

function buildTargetLogSummary(targets = []) {
  return targets
    .map((item) => {
      const url = item?.inspection?.url || item?.url || ''
      const visible = item?.inspection?.visibilityState || '-'
      const focused = item?.inspection?.hasFocus ? 'focus' : 'blur'
      return `${item?.targetId || '?'} | ${visible} | ${focused} | ${url}`
    })
    .join(' || ')
}

function getTargetScore(target) {
  const inspectedUrl = String(target?.inspection?.url || target?.url || '')
  let score = getUrlScore(inspectedUrl)

  if (target?.inspection?.visibilityState === 'visible') {
    score += 120
  }

  if (target?.inspection?.hasFocus) {
    score += 80
  }

  if ((target?.inspection?.title || '').includes('抖音')) {
    score += 10
  }

  return score
}

async function waitForPreferredTarget(httpBaseUrl) {
  const startTime = Date.now()

  while (Date.now() - startTime < 15000) {
    const rawTargets = await readJson(`${httpBaseUrl}/json/list`)
    const pageTargets = (rawTargets || []).filter(isCandidateTarget)

    if (pageTargets.length > 0) {
      const inspectedTargets = await Promise.all(
        pageTargets.map(async (target) => ({
          ...target,
          inspection: await inspectTarget(target)
        }))
      )

      inspectedTargets.sort((a, b) => getTargetScore(b) - getTargetScore(a))
      return {
        target: inspectedTargets[0],
        inspectedTargets
      }
    }

    await wait(500)
  }

  throw new Error('Timed out waiting for a BitBrowser page target')
}

function extractRemoteObjectText(remoteObject = {}) {
  if (remoteObject.type === 'string') {
    return String(remoteObject.value || '')
  }

  if (remoteObject.value !== undefined) {
    return String(remoteObject.value)
  }

  if (remoteObject.unserializableValue !== undefined) {
    return String(remoteObject.unserializableValue)
  }

  if (remoteObject.description) {
    return String(remoteObject.description)
  }

  return ''
}

function createConsoleText(params = {}) {
  return (params.args || []).map(extractRemoteObjectText).filter(Boolean).join(' ').trim()
}

function shouldForwardConsoleText(text) {
  if (!text) {
    return false
  }

  return text.includes('[douyin-fudai]') || text.includes('[douyin-fudai-bootstrap]')
}

function parsePageAgentEvent(text) {
  if (!text || !text.startsWith(PAGE_AGENT_EVENT_PREFIX)) {
    return null
  }

  const jsonText = text.slice(PAGE_AGENT_EVENT_PREFIX.length).trim()
  if (!jsonText) {
    return null
  }

  try {
    return JSON.parse(jsonText)
  } catch (_) {
    return null
  }
}

async function attachObserver(browserId, wsUrl, targetMeta = {}) {
  const client = new CdpConnection(wsUrl)

  await client.connect()
  await client.send('Runtime.enable')
  await client.send('Page.enable')

  client.on('Runtime.consoleAPICalled', (params) => {
    const text = createConsoleText(params)
    const pageAgentEvent = parsePageAgentEvent(text)

    if (pageAgentEvent) {
      if (
        pageAgentEvent.type === PAGE_AGENT_EVENT_TYPES.LOG &&
        typeof pageAgentEvent.payload?.message === 'string' &&
        pageAgentEvent.payload.message
      ) {
        emitAutomationLog({
          browserId,
          level: mapConsoleLevel(params.type),
          message: pageAgentEvent.payload.message,
          url: targetMeta.url || ''
        })
      }

      if (
        pageAgentEvent.type === PAGE_AGENT_EVENT_TYPES.ACCOUNT &&
        typeof pageAgentEvent.payload?.accountName === 'string' &&
        pageAgentEvent.payload.accountName
      ) {
        emitAutomationLog({
          browserId,
          level: 'INFO',
          message: `当前抖音账号: ${pageAgentEvent.payload.accountName}`,
          url: targetMeta.url || ''
        })
      }

      if (
        pageAgentEvent.type === PAGE_AGENT_EVENT_TYPES.BALANCE &&
        Number.isFinite(pageAgentEvent.payload?.diamondBalance)
      ) {
        emitAutomationLog({
          browserId,
          level: 'INFO',
          message: `当前钻石余额: ${pageAgentEvent.payload.diamondBalance}`,
          url: targetMeta.url || ''
        })
      }

      emitAutomationEvent({
        browserId,
        type: pageAgentEvent.type || PAGE_AGENT_EVENT_TYPES.STATUS,
        payload: pageAgentEvent.payload || {},
        url: targetMeta.url || ''
      })
      return
    }

    if (!shouldForwardConsoleText(text)) {
      return
    }

    emitAutomationLog({
      browserId,
      level: mapConsoleLevel(params.type),
      message: text,
      url: targetMeta.url || ''
    })
  })

  client.on('Runtime.exceptionThrown', (params) => {
    const description =
      params?.exceptionDetails?.exception?.description ||
      params?.exceptionDetails?.text ||
      'Unknown page exception'

    emitAutomationLog({
      browserId,
      level: 'ERROR',
      message: `Page exception: ${description}`,
      url: targetMeta.url || ''
    })
  })

  client.on('Inspector.detached', () => {
    emitAutomationLog({
      browserId,
      level: 'WARN',
      message: 'DevTools observer detached',
      url: targetMeta.url || ''
    })
  })

  return client
}

function mapConsoleLevel(type = '') {
  if (type === 'error' || type === 'assert') {
    return 'ERROR'
  }

  if (type === 'warning') {
    return 'WARN'
  }

  return 'INFO'
}

function normalizeRuntimeText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

async function readTaskRuntimeSnapshot(wsUrl) {
  return (
    (await evaluateValue(
      wsUrl,
      `(() => {
        const normalizeText = (value) =>
          typeof value === 'string' ? value.replace(/\\s+/g, ' ').trim() : '';

        const readAccountFromLogBox = () => {
          const logText = document.getElementById('douyin-fudai-log-box')?.innerText || '';
          const match = logText.match(/当前抖音账号[:：]\\s*([^\\n\\r]+)/);
          return match ? normalizeText(match[1]) : '';
        };

        const readBalanceFromLogBox = () => {
          const logText = document.getElementById('douyin-fudai-log-box')?.innerText || '';
          const match = logText.match(/当前钻石余额[:：]\\s*(\\d+)/);
          return match ? Number(match[1]) : 0;
        };

        const readAccountFromPanel = () => {
          const primaryNode = document.querySelector(
            '.Q6VYnosf.userMenuPanelShadowAnimation .NeAI6YYW .SgbdwJuv > a[href*="enter_method=personal_panel"]'
          );
          if (primaryNode) {
            const primaryText = normalizeText(primaryNode.textContent || primaryNode.innerText || '');
            if (primaryText) {
              return primaryText;
            }
          }

          const fallbackNode = document.querySelector(
            '.Q6VYnosf.userMenuPanelShadowAnimation .NeAI6YYW a.e6huIECy[href*="/user/self"]'
          );
          return normalizeText(fallbackNode?.textContent || fallbackNode?.innerText || '');
        };

        return {
          href: location.href,
          accountName: readAccountFromLogBox() || readAccountFromPanel(),
          diamondBalance: readBalanceFromLogBox()
        };
      })()`
    )) || {}
  )
}

function stopTaskRuntimeSync(task) {
  if (!task) {
    return
  }

  if (task.runtimeSyncTimer) {
    clearInterval(task.runtimeSyncTimer)
    task.runtimeSyncTimer = null
  }
}

function stopTaskBalanceSync(task) {
  if (!task) {
    return
  }

  if (task.balanceSyncTimer) {
    clearTimeout(task.balanceSyncTimer)
    task.balanceSyncTimer = null
  }
}

async function syncTaskRuntimeState(task) {
  if (!task?.pageDebuggerUrl || task.isStopping) {
    return
  }

  try {
    const snapshot = await readTaskRuntimeSnapshot(task.pageDebuggerUrl)
    const accountName = normalizeRuntimeText(snapshot?.accountName)
    const diamondBalance = Number(snapshot?.diamondBalance) || 0

    if (accountName && accountName !== task.lastAccountName) {
      task.lastAccountName = accountName
      emitAutomationLog({
        browserId: task.browserId,
        level: 'INFO',
        message: `当前抖音账号: ${accountName}`
      })
      emitAutomationEvent({
        browserId: task.browserId,
        type: PAGE_AGENT_EVENT_TYPES.ACCOUNT,
        payload: {
          accountName
        }
      })
    }

    if (diamondBalance > 0 && diamondBalance !== task.lastDiamondBalance) {
      task.lastDiamondBalance = diamondBalance
      emitAutomationLog({
        browserId: task.browserId,
        level: 'INFO',
        message: `当前钻石余额: ${diamondBalance}`
      })
      emitAutomationEvent({
        browserId: task.browserId,
        type: PAGE_AGENT_EVENT_TYPES.BALANCE,
        payload: {
          diamondBalance
        }
      })
    }
  } catch (_) {
    // Ignore polling failures to avoid disturbing the running page flow.
  }
}

function startTaskRuntimeSync(task) {
  if (!task || task.runtimeSyncTimer) {
    return
  }

  task.runtimeSyncTimer = setInterval(() => {
    void syncTaskRuntimeState(task)
  }, RUNTIME_SYNC_INTERVAL_MS)

  void syncTaskRuntimeState(task)
}

async function readDiamondBalanceFromPage(wsUrl) {
  return (
    (await evaluateValue(
      wsUrl,
      `(() => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const normalizeText = (value) =>
          typeof value === 'string' ? value.replace(/\\s+/g, ' ').trim() : '';

        const isLivePage = () =>
          location.hostname.includes('live.douyin.com') || location.pathname.includes('/root/live/');

        const isRecommendPage = () =>
          location.hostname.includes('www.douyin.com') && !isLivePage();

        const isVisible = (node) => {
          if (!node) {
            return false;
          }

          const rect = node.getBoundingClientRect?.();
          const style = window.getComputedStyle(node);
          return Boolean(rect) && rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };

        const humanClick = (node) => {
          if (!node) {
            return false;
          }

          const rect = node.getBoundingClientRect?.();
          const clientX = rect ? rect.left + Math.max(8, Math.min(rect.width - 8, rect.width / 2)) : 12;
          const clientY = rect ? rect.top + Math.max(8, Math.min(rect.height - 8, rect.height / 2)) : 12;
          const eventInit = {
            bubbles: true,
            cancelable: true,
            clientX,
            clientY
          };

          try {
            node.dispatchEvent(new MouseEvent('mouseenter', eventInit));
            node.dispatchEvent(new MouseEvent('mouseover', eventInit));
            node.dispatchEvent(new MouseEvent('mousemove', eventInit));
            node.dispatchEvent(new MouseEvent('mousedown', eventInit));
            node.dispatchEvent(new MouseEvent('mouseup', eventInit));
            node.dispatchEvent(new MouseEvent('click', eventInit));
            return true;
          } catch (_) {
            return false;
          }
        };

        const getRechargeEntryNode = () =>
          Array.from(document.querySelectorAll('div[data-e2e="something-button"]')).find((node) => isVisible(node)) || null;

        const getCloseNode = () => {
          const node = document.querySelector('.recharge-header-close');
          return isVisible(node) ? node : null;
        };

        const getBalanceNode = () => {
          const node = document.querySelector('.recharge-header-balance .balance-amount');
          return isVisible(node) ? node : null;
        };

        const readBalance = () => {
          const text = normalizeText(getBalanceNode()?.textContent || '');
          const match = text.match(/\\d+/);
          return match ? Number(match[0]) : 0;
        };

        return (async () => {
          if (!isRecommendPage()) {
            return {
              status: 'skipped',
              reason: 'not-recommend-page',
              href: location.href
            };
          }

          const entryNode = getRechargeEntryNode();
          if (!entryNode) {
            return {
              status: 'failed',
              reason: 'entry-not-found',
              href: location.href
            };
          }

          if (!humanClick(entryNode)) {
            return {
              status: 'failed',
              reason: 'entry-click-failed',
              href: location.href
            };
          }

          const startTime = Date.now();
          let diamondBalance = 0;
          while (Date.now() - startTime < 5000) {
            diamondBalance = readBalance();
            if (diamondBalance > 0) {
              break;
            }
            await wait(200);
          }

          const closeNode = getCloseNode();
          if (closeNode) {
            humanClick(closeNode);
            await wait(200);
          }

          if (diamondBalance > 0) {
            return {
              status: 'success',
              diamondBalance,
              href: location.href
            };
          }

          return {
            status: 'failed',
            reason: 'balance-not-found',
            href: location.href
          };
        })();
      })()`
    )) || {}
  )
}

async function syncTaskDiamondBalance(task) {
  if (!task?.pageDebuggerUrl || task.isStopping || task.balanceSyncDone) {
    return
  }

  task.balanceSyncAttempts = Number(task.balanceSyncAttempts || 0) + 1

  try {
    const result = await readDiamondBalanceFromPage(task.pageDebuggerUrl)
    const diamondBalance = Number(result?.diamondBalance) || 0

    if (result?.status === 'success' && diamondBalance > 0) {
      task.balanceSyncDone = true
      emitAutomationLog({
        browserId: task.browserId,
        level: 'INFO',
        message: `当前钻石余额: ${diamondBalance}`
      })
      emitAutomationEvent({
        browserId: task.browserId,
        type: PAGE_AGENT_EVENT_TYPES.BALANCE,
        payload: {
          diamondBalance
        }
      })
      return
    }

    if (result?.status === 'skipped') {
      task.balanceSyncDone = true
      emitAutomationLog({
        browserId: task.browserId,
        level: 'INFO',
        message: `钻石余额同步跳过: ${result?.reason || 'unknown'}`
      })
      return
    }

    if (task.balanceSyncAttempts < BALANCE_SYNC_MAX_ATTEMPTS) {
      emitAutomationLog({
        browserId: task.browserId,
        level: 'INFO',
        message: `钻石余额未读取成功，准备第 ${task.balanceSyncAttempts + 1} 次重试`
      })
      startTaskBalanceSync(task, BALANCE_SYNC_RETRY_DELAY_MS)
      return
    }

    task.balanceSyncDone = true
    if (result?.status === 'failed') {
      emitAutomationLog({
        browserId: task.browserId,
        level: 'WARN',
        message: `钻石余额同步失败: ${result?.reason || 'unknown'}`
      })
    }
  } catch (error) {
    if (task.balanceSyncAttempts < BALANCE_SYNC_MAX_ATTEMPTS) {
      emitAutomationLog({
        browserId: task.browserId,
        level: 'INFO',
        message: `钻石余额同步异常，准备第 ${task.balanceSyncAttempts + 1} 次重试`
      })
      startTaskBalanceSync(task, BALANCE_SYNC_RETRY_DELAY_MS)
      return
    }

    task.balanceSyncDone = true
    emitAutomationLog({
      browserId: task.browserId,
      level: 'WARN',
      message: `钻石余额同步异常: ${error?.message || error || 'unknown'}`
    })
  }
}

function startTaskBalanceSync(task, delayMs = BALANCE_SYNC_DELAY_MS) {
  if (!task || task.balanceSyncTimer || task.balanceSyncDone) {
    return
  }

  task.balanceSyncTimer = setTimeout(() => {
    task.balanceSyncTimer = null
    void syncTaskDiamondBalance(task)
  }, delayMs)
}

function buildBootstrapSource(options = {}) {
  const optionsJson = JSON.stringify(options)

  return `
(() => {
  const STORAGE_KEY = ${JSON.stringify(AUTOMATION_STORAGE_KEY)};
  const OPTIONS_KEY = ${JSON.stringify(AUTOMATION_OPTIONS_KEY)};
  const FEED_SELECTOR = ${JSON.stringify(FEED_ITEM_SELECTOR)};
  const EVENT_PREFIX = ${JSON.stringify(PAGE_AGENT_EVENT_PREFIX)};

  function log(message, level = 'log') {
    const prefix = '[douyin-fudai-bootstrap]';
    const logger = console[level] || console.log;
    logger.call(console, prefix, message);
  }

  function emitPageAgentEvent(type, payload = {}) {
    try {
      console.log(EVENT_PREFIX, JSON.stringify({
        type,
        payload,
        href: location.href,
        at: new Date().toISOString()
      }));
    } catch (_) {
      // noop
    }
  }

  function getVisibleFeedItems() {
    return Array.from(document.querySelectorAll(FEED_SELECTOR)).filter((node) => {
      const rect = node.getBoundingClientRect?.();
      return Boolean(rect) && rect.width > 0 && rect.height > 0;
    });
  }

  function isNodeVisible(node) {
    if (!node) {
      return false;
    }

    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect?.();
    return Boolean(rect) && rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  }

  function getRecommendNavCandidates() {
    return Array.from(document.querySelectorAll('a, button, div[role="button"]'))
      .filter((node) => isNodeVisible(node))
      .map((node) => ({
        node,
        text: (node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim()
      }))
      .filter((item) => item.text === '推荐' || /(^|\\s)推荐(\\s|$)/.test(item.text));
  }

  function hasRecommendNavActiveState(node) {
    if (!node) {
      return false;
    }

    const className = String(node.className || '').toLowerCase();
    const ariaCurrent = String(node.getAttribute?.('aria-current') || '').toLowerCase();
    const ariaSelected = String(node.getAttribute?.('aria-selected') || '').toLowerCase();

    return ariaCurrent === 'page'
      || ariaSelected === 'true'
      || className.includes('active')
      || className.includes('selected')
      || className.includes('current');
  }

  function installCompatibilityLayer() {
    window.isLivePage = () =>
      location.hostname.includes('live.douyin.com') || location.pathname.includes('/root/live/');

    window.getFeedItems = () => getVisibleFeedItems();

    window.isRecommendPage = () => {
      if (!location.hostname.includes('douyin.com') || window.isLivePage()) {
        return false;
      }

      if (location.href.includes('/jingxuan')) {
        return false;
      }

      const hasFeedItems = window.getFeedItems().length > 0;
      if (!hasFeedItems) {
        return false;
      }

      return location.href.includes('recommend=1');
    };
  }

  function ensureCoreLoaded() {
    return typeof window.installDouyinFudaiAutomation === 'function';
  }

  function getStoredOptions() {
    try {
      return JSON.parse(localStorage.getItem(OPTIONS_KEY) || '{}');
    } catch (_) {
      return {};
    }
  }

  function setStoredOptions(nextOptions) {
    try {
      localStorage.setItem(OPTIONS_KEY, JSON.stringify(nextOptions || {}));
    } catch (_) {
      // noop
    }
  }

  function setRunningFlag(running) {
    try {
      localStorage.setItem(STORAGE_KEY, running ? '1' : '0');
    } catch (_) {
      // noop
    }
  }

  function ensureApi() {
    if (!ensureCoreLoaded()) {
      return null;
    }

    installCompatibilityLayer();
    window.__douyinPageAgentBridge = {
      getConfig: getStoredOptions,
      emit: emitPageAgentEvent
    };
    return window.installDouyinFudaiAutomation(getStoredOptions());
  }

  async function waitForPageReady(timeoutMs = 10000) {
    if (document.readyState !== 'loading' && document.body) {
      return true;
    }

    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };

      const timer = setTimeout(finish, timeoutMs);
      document.addEventListener('DOMContentLoaded', () => {
        clearTimeout(timer);
        finish();
      }, { once: true });
      window.addEventListener('load', () => {
        clearTimeout(timer);
        finish();
      }, { once: true });
    });

    return Boolean(document.body);
  }

  async function startBackground() {
    await waitForPageReady();
    setRunningFlag(true);
    const api = ensureApi();
    if (!api) {
      log('core api missing', 'error');
      return { status: 'missing-api' };
    }

    if (window.__douyinFudaiStartPromise) {
      return { status: 'already-starting' };
    }

    log(\`startBackground on \${location.href}\`);
    emitPageAgentEvent(${JSON.stringify(PAGE_AGENT_EVENT_TYPES.STATUS)}, {
      stage: 'start-background',
      href: location.href
    });

    window.__douyinFudaiStartPromise = (async () => {
      while (localStorage.getItem(STORAGE_KEY) === '1') {
        const currentApi = ensureApi();
        if (!currentApi || typeof currentApi.startFlow !== 'function') {
          log('startFlow missing', 'error');
          return { status: 'missing-api' };
        }

        try {
          const result = await currentApi.startFlow();
          log(\`startFlow result: \${JSON.stringify(result || {})}\`);
          emitPageAgentEvent(${JSON.stringify(PAGE_AGENT_EVENT_TYPES.FLOW)}, {
            stage: 'start-flow-result',
            result: result || {}
          });

          if (!result?.retryable) {
            return result || { status: 'finished' };
          }

          const retryDelayMs = Math.max(500, Number(result.retryDelayMs) || 2000);
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        } catch (error) {
          log(\`startFlow error: \${error?.message || error}\`, 'error');
          emitPageAgentEvent(${JSON.stringify(PAGE_AGENT_EVENT_TYPES.ERROR)}, {
            stage: 'start-flow-error',
            message: error?.message || String(error || 'unknown error')
          });
          return {
            status: 'error',
            message: error?.message || String(error || 'unknown error')
          };
        }
      }

      return { status: 'stopped' };
    })().finally(() => {
      window.__douyinFudaiStartPromise = null;
    });

    return { status: 'started' };
  }

  async function stopBackground() {
    setRunningFlag(false);
    const api = ensureApi();
    if (!api || typeof api.stopFlow !== 'function') {
      return { status: 'missing-stop' };
    }

    log('stopBackground called');
    emitPageAgentEvent(${JSON.stringify(PAGE_AGENT_EVENT_TYPES.STATUS)}, {
      stage: 'stop-background'
    });
    return api.stopFlow();
  }

  function autoStartIfNeeded() {
    try {
      if (localStorage.getItem(STORAGE_KEY) === '1') {
        setTimeout(() => {
          startBackground();
        }, 1200);
      }
    } catch (_) {
      // noop
    }
  }

  installCompatibilityLayer();

  window.__douyinFudaiRunner = {
    ensureApi,
    startBackground,
    stopBackground,
    setStoredOptions,
    emitPageAgentEvent
  };

  setStoredOptions(${optionsJson});
  log(\`bootstrap ready on \${location.href}\`);
  autoStartIfNeeded();
})();
`.trim()
}

function buildPageSource(options = {}) {
  const bootstrapSource = buildBootstrapSource(options)
  return `
${douyinFudaiCoreSource}
${bootstrapSource}
`.trim()
}

async function installAutomationToPage(wsUrl, options) {
  const source = buildPageSource(options)
  const client = new CdpConnection(wsUrl)

  try {
    await client.connect()
    await client.send('Runtime.enable')
    await client.send('Page.enable')
    await client.send('Page.bringToFront')
    const navigation = await ensureTargetAtHomePage(client, options?.entranceUrl || 'https://www.douyin.com')

    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source
    })

    await client.send('Runtime.evaluate', {
      expression: source,
      awaitPromise: true,
      returnByValue: true
    })

    const state = await client.send('Runtime.evaluate', {
      expression: `(() => ({
        href: location.href,
        title: document.title,
        visibilityState: document.visibilityState,
        readyState: document.readyState,
        hasBody: Boolean(document.body),
        hasInstall: typeof window.installDouyinFudaiAutomation === 'function',
        hasRunner: Boolean(window.__douyinFudaiRunner)
      }))()`,
      awaitPromise: true,
      returnByValue: true
    })

    const result = await client.send('Runtime.evaluate', {
      expression: 'window.__douyinFudaiRunner.startBackground()',
      awaitPromise: true,
      returnByValue: true
    })

    await wait(1800)
    const runtimeState = await client.send('Runtime.evaluate', {
      expression: `(() => ({
        href: location.href,
        readyState: document.readyState,
        hasLogBox: Boolean(document.getElementById('douyin-fudai-log-box')),
        hasRunner: Boolean(window.__douyinFudaiRunner),
        hasInstall: typeof window.installDouyinFudaiAutomation === 'function'
      }))()`,
      awaitPromise: true,
      returnByValue: true
    })

    return {
      navigation,
      pageState: state?.result?.value || {},
      runtimeState: runtimeState?.result?.value || {},
      startResult: result?.result?.value || { status: 'started' }
    }
  } finally {
    client.close()
  }
}

async function ensureTargetAtHomePage(client, entranceUrl) {
  const readPageState = async () =>
    await evaluateOnClient(
      client,
      `(() => ({
        href: location.href,
        readyState: document.readyState
      }))()`
    )

  const beforeState = await readPageState()
  const beforeUrl = String(beforeState?.href || '')

  if (isDouyinHomeUrl(beforeUrl)) {
    return {
      navigated: false,
      beforeUrl,
      afterUrl: beforeUrl
    }
  }

  await client.send('Page.navigate', {
    url: entranceUrl
  })

  const startTime = Date.now()
  while (Date.now() - startTime < 15000) {
    const currentState = await readPageState()
    const currentUrl = String(currentState?.href || '')
    const readyState = String(currentState?.readyState || '')

    if (isDouyinHomeUrl(currentUrl) && (readyState === 'interactive' || readyState === 'complete')) {
      return {
        navigated: true,
        beforeUrl,
        afterUrl: currentUrl
      }
    }

    await wait(500)
  }

  throw new Error(`Timed out navigating target to Douyin home. Current url: ${beforeUrl}`)
}

function getSelectedBrowserIds(browserIds = [], limit = 0) {
  const ids = browserIds.filter((id) => typeof id === 'string' && id.trim() !== '')

  if (!limit || limit >= ids.length) {
    return ids
  }

  return ids.slice(0, limit)
}

export async function startDouyinAutomation(postBitBrowser, browserIds = [], options = {}) {
  const selectedIds = getSelectedBrowserIds(browserIds, Number(options.threadCount) || 0)
  const startedItems = []
  const skippedItems = []
  const failedItems = []

  for (const browserId of selectedIds) {
    if (activeAutomationTasks.has(browserId)) {
      skippedItems.push({
        browserId,
        reason: 'already-running'
      })
      emitAutomationLog({
        browserId,
        level: 'WARN',
        message: 'Skipped because automation is already running'
      })
      continue
    }

    let observer = null

    try {
      emitAutomationLog({
        browserId,
        message: 'Opening BitBrowser window'
      })

      const openPayload = await postBitBrowser('/browser/open', {
        id: browserId
      })

      const httpBaseUrl = normalizeHttpBase(openPayload?.data?.http)
      emitAutomationLog({
        browserId,
        message: `Remote debug http: ${httpBaseUrl}`
      })

      const { target, inspectedTargets } = await waitForPreferredTarget(httpBaseUrl)

      emitAutomationLog({
        browserId,
        message: `Selected target: ${target?.inspection?.url || target?.url || ''}`
      })

      emitAutomationLog({
        browserId,
        message: `Target candidates: ${buildTargetLogSummary(inspectedTargets)}`
      })

      observer = await attachObserver(browserId, target.webSocketDebuggerUrl, {
        url: target?.inspection?.url || target?.url || ''
      })

      const installResult = await installAutomationToPage(target.webSocketDebuggerUrl, options)

      emitAutomationLog({
        browserId,
        message: installResult?.navigation?.navigated
          ? `Forced navigation to home: ${installResult?.navigation?.beforeUrl || ''} -> ${installResult?.navigation?.afterUrl || ''}`
          : `Target already at home: ${installResult?.navigation?.afterUrl || ''}`
      })

      emitAutomationLog({
        browserId,
        message: `Install state: ${JSON.stringify(installResult.pageState || {})}`
      })

      emitAutomationLog({
        browserId,
        message: `Runtime state: ${JSON.stringify(installResult.runtimeState || {})}`
      })

      emitAutomationLog({
        browserId,
        message: `Start result: ${JSON.stringify(installResult.startResult || {})}`
      })

      const task = {
        browserId,
        httpBaseUrl,
        pageDebuggerUrl: target.webSocketDebuggerUrl,
        observer,
        options,
        startedAt: Date.now(),
        targetUrl: target?.inspection?.url || target?.url || '',
        runtimeSyncTimer: null,
        balanceSyncTimer: null,
        balanceSyncAttempts: 0,
        balanceSyncDone: false,
        lastAccountName: '',
        lastDiamondBalance: 0
      }

      activeAutomationTasks.set(browserId, task)
      startTaskRuntimeSync(task)

      startedItems.push({
        browserId,
        status: installResult?.startResult?.status || 'started'
      })
    } catch (error) {
      observer?.close()
      activeAutomationTasks.delete(browserId)

      const message = error?.message || 'Failed to start automation'
      emitAutomationLog({
        browserId,
        level: 'ERROR',
        message
      })

      failedItems.push({
        browserId,
        message
      })
    }
  }

  return {
    requestedCount: selectedIds.length,
    startedCount: startedItems.length,
    skippedCount: skippedItems.length,
    failedCount: failedItems.length,
    startedItems,
    skippedItems,
    failedItems
  }
}

export async function stopDouyinAutomation(browserIds = []) {
  const selectedIds = getSelectedBrowserIds(browserIds)
  const stoppedItems = []
  const failedItems = []

  for (const browserId of selectedIds) {
    const task = activeAutomationTasks.get(browserId)

    if (!task) {
      continue
    }

    try {
      task.isStopping = true
      stopTaskRuntimeSync(task)
      stopTaskBalanceSync(task)
      await evaluateValue(task.pageDebuggerUrl, 'window.__douyinFudaiRunner?.stopBackground?.()')
      task.observer?.close()
      activeAutomationTasks.delete(browserId)

      emitAutomationLog({
        browserId,
        message: 'Automation stopped'
      })

      stoppedItems.push({ browserId })
    } catch (error) {
      const message = error?.message || 'Failed to stop automation'
      emitAutomationLog({
        browserId,
        level: 'ERROR',
        message
      })

      failedItems.push({
        browserId,
        message
      })
    }
  }

  return {
    requestedCount: selectedIds.length,
    stoppedCount: stoppedItems.length,
    failedCount: failedItems.length,
    stoppedItems,
    failedItems
  }
}

export function getActiveDouyinAutomationCount() {
  return activeAutomationTasks.size
}
