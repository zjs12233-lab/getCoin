import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'
import os from 'os'
import { electronApp, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { AUTOMATION_EVENT_CHANNEL, AUTOMATION_LOG_CHANNEL } from '../shared/automationProtocol'
import {
  getActiveDouyinAutomationCount,
  onAutomationEvent,
  onAutomationLog,
  startDouyinAutomation,
  stopDouyinAutomation
} from './douyinAutomation'
import { configureWindowSecurity, createSecureWebPreferences } from './appSecurity'

const WINDOW_TITLE = '彩虹福袋'
const BITBROWSER_API_BASE_URL = process.env.BITBROWSER_API_BASE_URL || 'http://127.0.0.1:54345'
const BITBROWSER_PAGE_SIZE = 100
const BITBROWSER_WINDOW_LAYOUT = {
  startX: 0,
  startY: 0,
  width: 700,
  height: 520,
  spaceX: 0,
  spaceY: 0,
  offsetX: 30,
  offsetY: 30
}
const BITBROWSER_WINDOW_MAX_COLUMNS = 3

function getBitBrowserApiBaseUrl() {
  return BITBROWSER_API_BASE_URL.replace(/\/+$/, '')
}

async function postBitBrowser(path, body = {}) {
  const response = await fetch(`${getBitBrowserApiBaseUrl()}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })

  let payload

  try {
    payload = await response.json()
  } catch {
    throw new Error(`比特浏览器接口返回的不是有效 JSON，路径: ${path}`)
  }

  if (!response.ok) {
    throw new Error(payload?.msg || `比特浏览器接口请求失败: ${response.status}`)
  }

  if (payload?.success === false) {
    throw new Error(payload?.msg || '比特浏览器接口返回失败')
  }

  return payload
}

function readArrayCandidates(payload) {
  const candidates = [
    payload?.data?.list,
    payload?.data?.data?.list,
    payload?.data?.items,
    payload?.data?.content,
    payload?.content,
    payload?.list,
    payload?.data
  ]

  return candidates.find((item) => Array.isArray(item)) || []
}

async function getBitBrowserBrowserList() {
  const allItems = []
  let page = 0

  while (true) {
    const payload = await postBitBrowser('/browser/list', {
      page,
      pageSize: BITBROWSER_PAGE_SIZE
    })

    const currentItems = readArrayCandidates(payload)
    allItems.push(...currentItems)

    if (currentItems.length < BITBROWSER_PAGE_SIZE) {
      break
    }

    page += 1

    if (page > 100) {
      break
    }
  }

  return {
    items: allItems,
    apiBaseUrl: getBitBrowserApiBaseUrl()
  }
}

async function arrangeBitBrowserWindows() {
  const primaryDisplay = screen.getPrimaryDisplay()
  const workAreaWidth = primaryDisplay?.workAreaSize?.width ?? primaryDisplay?.bounds?.width ?? 0
  const horizontalStep =
    BITBROWSER_WINDOW_LAYOUT.width +
    BITBROWSER_WINDOW_LAYOUT.spaceX +
    BITBROWSER_WINDOW_LAYOUT.offsetX
  const availableWidth = Math.max(workAreaWidth - BITBROWSER_WINDOW_LAYOUT.startX, 0)
  const autoCol = Math.max(1, Math.floor(availableWidth / Math.max(horizontalStep, 1)))
  const col = Math.min(autoCol, BITBROWSER_WINDOW_MAX_COLUMNS)

  await postBitBrowser('/windowbounds', {
    type: 'box',
    ...BITBROWSER_WINDOW_LAYOUT,
    col
  })

  return {
    success: true,
    apiBaseUrl: getBitBrowserApiBaseUrl(),
    col
  }
}

async function closeAllBitBrowserWindows() {
  const { items } = await getBitBrowserBrowserList()
  const seqs = items
    .map((item) => item?.seq)
    .filter((seq) => Number.isInteger(seq) || (typeof seq === 'string' && seq.trim() !== ''))

  if (!seqs.length) {
    return {
      success: true,
      closedCount: 0,
      apiBaseUrl: getBitBrowserApiBaseUrl()
    }
  }

  await postBitBrowser('/browser/close/byseqs', {
    seqs
  })

  return {
    success: true,
    closedCount: seqs.length,
    apiBaseUrl: getBitBrowserApiBaseUrl()
  }
}

async function openBitBrowserWindows(browserIds = []) {
  const ids = browserIds.filter((id) => typeof id === 'string' && id.trim() !== '')

  if (!ids.length) {
    return {
      success: true,
      openedCount: 0,
      failedCount: 0,
      failedItems: [],
      apiBaseUrl: getBitBrowserApiBaseUrl()
    }
  }

  let openedCount = 0
  const failedItems = []

  for (const id of ids) {
    try {
      await postBitBrowser('/browser/open', {
        id
      })
      openedCount += 1
    } catch (error) {
      failedItems.push({
        id,
        message: error?.message || '打开失败'
      })
    }
  }

  return {
    success: failedItems.length === 0,
    openedCount,
    failedCount: failedItems.length,
    failedItems,
    apiBaseUrl: getBitBrowserApiBaseUrl()
  }
}

async function closeBitBrowserIds(browserIds = []) {
  const ids = browserIds.filter((id) => typeof id === 'string' && id.trim() !== '')
  let closedCount = 0
  const failedItems = []

  for (const id of ids) {
    try {
      await postBitBrowser('/browser/close', { id })
      closedCount += 1
    } catch (error) {
      failedItems.push({
        id,
        message: error?.message || '关闭浏览器失败'
      })
    }
  }

  return {
    requestedCount: ids.length,
    closedCount,
    failedCount: failedItems.length,
    failedItems
  }
}

async function startDouyinFudaiRun(payload = {}) {
  const browserIds = Array.isArray(payload?.browserIds) ? payload.browserIds : []
  const options = payload?.options || {}

  return await startDouyinAutomation(postBitBrowser, browserIds, options)
}

async function stopDouyinFudaiRun(payload = {}) {
  const browserIds = Array.isArray(payload?.browserIds) ? payload.browserIds : []
  const stopResult = await stopDouyinAutomation(browserIds)
  const closeResult = await closeBitBrowserIds(browserIds)

  return {
    requestedCount: browserIds.length,
    stoppedCount: stopResult?.stoppedCount ?? 0,
    stopFailedCount: stopResult?.failedCount ?? 0,
    closedCount: closeResult?.closedCount ?? 0,
    closeFailedCount: closeResult?.failedCount ?? 0,
    failedItems: [...(stopResult?.failedItems || []), ...(closeResult?.failedItems || [])]
  }
}

function getRuntimeMetrics() {
  const processMetrics = app.getAppMetrics()
  const totalCpuPercent = processMetrics.reduce(
    (sum, metric) => sum + (metric?.cpu?.percentCPUUsage || 0),
    0
  )
  const totalWorkingSetBytes = processMetrics.reduce(
    (sum, metric) => sum + (metric?.memory?.workingSetSize || 0),
    0
  )
  const totalSystemMemory = os.totalmem()
  const memoryPercent = totalSystemMemory > 0 ? (totalWorkingSetBytes / totalSystemMemory) * 100 : 0

  return {
    cpuPercent: Number(totalCpuPercent.toFixed(1)),
    memoryPercent: Number(memoryPercent.toFixed(1)),
    memoryUsedMB: Number((totalWorkingSetBytes / 1024 / 1024).toFixed(1)),
    automationCount: getActiveDouyinAutomationCount()
  }
}

function registerIpcHandlers() {
  ipcMain.removeHandler('app:metrics')
  ipcMain.handle('app:metrics', async () => getRuntimeMetrics())

  ipcMain.removeHandler('bitbrowser:list')
  ipcMain.handle('bitbrowser:list', async () => await getBitBrowserBrowserList())

  ipcMain.removeHandler('bitbrowser:arrange')
  ipcMain.handle('bitbrowser:arrange', async () => await arrangeBitBrowserWindows())

  ipcMain.removeHandler('bitbrowser:close-all')
  ipcMain.handle('bitbrowser:close-all', async () => await closeAllBitBrowserWindows())

  ipcMain.removeHandler('bitbrowser:open')
  ipcMain.handle('bitbrowser:open', async (_, browserIds) => await openBitBrowserWindows(browserIds))

  ipcMain.removeHandler('douyin:start')
  ipcMain.handle('douyin:start', async (_, payload) => await startDouyinFudaiRun(payload))

  ipcMain.removeHandler('douyin:stop')
  ipcMain.handle('douyin:stop', async (_, payload) => await stopDouyinFudaiRun(payload))
}

function registerAutomationLogForwarder() {
  onAutomationLog((payload) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(AUTOMATION_LOG_CHANNEL, payload)
      }
    }
  })
}

function registerAutomationEventForwarder() {
  onAutomationEvent((payload) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(AUTOMATION_EVENT_CHANNEL, payload)
      }
    }
  })
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    title: WINDOW_TITLE,
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: createSecureWebPreferences({
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    })
  })

  configureWindowSecurity(mainWindow)

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault()
    mainWindow.setTitle(WINDOW_TITLE)
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.setTitle(WINDOW_TITLE)
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron')

  ipcMain.on('ping', () => console.log('pong'))
  registerIpcHandlers()
  registerAutomationLogForwarder()
  registerAutomationEventForwarder()

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
