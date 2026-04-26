<template>
  <div class="desktop-shell">
    <main class="workspace">
      <section class="panel controls-panel">
        <div class="action-row">
          <button
            class="action-btn is-green"
            :disabled="isLoadingBrowsers || isArrangingWindows || isClosingWindows || isStartingRun || isStoppingRun"
            @click="fetchBrowserWindowInfo"
          >
            获取所有浏览器窗口信息
          </button>
          <button
            class="action-btn is-purple"
            :disabled="isLoadingBrowsers || isArrangingWindows || isClosingWindows || isStartingRun || isStoppingRun"
            @click="arrangeWindows"
          >
            一键排列窗口
          </button>
          <button
            class="action-btn is-deep-purple"
            :disabled="isLoadingBrowsers || isArrangingWindows || isClosingWindows || isStartingRun || isStoppingRun"
            @click="closeAllWindows"
          >
            关闭所有窗口
          </button>
          <button
            class="action-btn is-green-alt"
            :disabled="isLoadingBrowsers || isArrangingWindows || isClosingWindows || isStartingRun || isStoppingRun"
            @click="startRun"
          >
            开始运行
          </button>
          <button
            class="action-btn is-red"
            :disabled="isLoadingBrowsers || isArrangingWindows || isClosingWindows || isStartingRun || isStoppingRun"
            @click="stopRun"
          >
            停止运行
          </button>
        </div>

        <div class="form-row form-row--subtle">
          <div class="field select-field">
            <label class="mode-label">钻石数量配置</label>
            <el-select v-model="form.diamondRange" size="small">
              <el-option label="1-100" value="1-100" />
              <el-option label="101-200" value="101-200" />
              <el-option label="201-300" value="201-300" />
              <el-option label="大于301" value="301+" />
            </el-select>
          </div>
         
        </div>
      </section>

      <section class="panel table-panel">
        <div class="tab-row">
          <button
            v-for="tab in tabs"
            :key="tab"
            class="tab-btn"
            :class="{ 'is-active': tab === activeTab }"
            @click="activeTab = tab"
          >
            {{ tab }}
          </button>
        </div>

        <div class="table-wrap">
          <el-table
            ref="browserTableRef"
            :data="browserRows"
            row-key="browserId"
            border
            height="100%"
            size="small"
            class="browser-table"
            empty-text="点击“获取所有浏览器窗口信息”后显示比特浏览器数据"
            @selection-change="handleSelectionChange"
          >
            <el-table-column type="selection" width="48" align="center" reserve-selection />
            <el-table-column prop="seq" label="序号" width="60" />
            <el-table-column prop="browserId" label="浏览器ID" min-width="180" />
            <el-table-column prop="status" label="状态" width="90" />
            <el-table-column prop="name" label="浏览器窗口名称" min-width="160" />
             <el-table-column prop="userName" label="平台账号" min-width="140" />
             <el-table-column prop="diamondBalance" label="钻石余额" width="100" />
            <el-table-column prop="remark" label="备注" min-width="140" />
            <el-table-column prop="groupName" label="分组" width="100" />
            <el-table-column prop="proxyType" label="代理类型" width="90" />
            <el-table-column prop="proxyHost" label="代理主机" min-width="140" />
            <el-table-column prop="proxyPort" label="端口" width="80" />
            <el-table-column prop="platform" label="平台" min-width="160" />
          </el-table>
        </div>
      </section>

      <section class="bottom-section">
        <div class="panel logs-panel">
          <div class="logs-toolbar">
            <span class="metrics cpu">CPU: {{ runtimeMetrics.cpuPercent.toFixed(1) }}%</span>
            <span class="metrics memory">
              内存: {{ runtimeMetrics.memoryPercent.toFixed(1) }}% ({{ runtimeMetrics.memoryUsedMB.toFixed(1) }} MB)
            </span>
            <span class="muted-text">已加载 {{ browserCount }} 个浏览器</span>
            <span class="muted-text">已勾选 {{ selectedBrowserCount }} 个</span>
            <span class="muted-text">运行中 {{ runtimeMetrics.automationCount }} 个</span>
            <span class="warning-text">请先确保比特浏览器已开启，并已在系统设置中启用 Local API。</span>
          </div>

          <div class="logs-content">
            <pre>{{ logLines.join('\n') }}</pre>
            <button class="ghost-btn" @click="clearLogs">清空日志</button>
          </div>
        </div>

        
      </section>
    </main>
  </div>
</template>
<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { PAGE_AGENT_EVENT_TYPES } from '../../shared/automationProtocol'

const form = ref({
  interval: 0.5,
  average: 10,
  diamondRange: '1-100',
  remainingTime: 60,
  fanGroup: true,
  apiOnly: true,
  executeCount: 5,
  stopLimit: 1,
  finishClose: false,
  joinLimit: 5,
  redPacketLimit: 0,
  singleMode: false,
  roundInterval: 3600
})

const tabs = ['浏览器管理',]
const activeTab = ref('浏览器管理')
const browserTableRef = ref(null)
const browserRows = ref([])
const selectedBrowserRows = ref([])
const runtimeRowPatches = ref({})
const recentRunBrowserIds = ref([])
const isLoadingBrowsers = ref(false)
const isArrangingWindows = ref(false)
const isClosingWindows = ref(false)
const isStartingRun = ref(false)
const isStoppingRun = ref(false)
const runtimeMetrics = ref({
  cpuPercent: 0,
  memoryPercent: 0,
  memoryUsedMB: 0,
  automationCount: 0
})
const logLines = ref([
  '[INFO] 等待获取比特浏览器窗口信息'
])

const browserCount = computed(() => browserRows.value.length)
const selectedBrowserCount = computed(() => selectedBrowserRows.value.length)
let metricsTimer = null
let disposeAutomationLog = null
let disposeAutomationEvent = null

async function invokeBitBrowser(channel, apiMethod, ...args) {
  if (window.api?.[apiMethod]) {
    return await window.api[apiMethod](...args)
  }

  if (window.electron?.ipcRenderer?.invoke) {
    return await window.electron.ipcRenderer.invoke(channel, ...args)
  }

  throw new Error('当前客户端未注入 Electron 预加载接口，请彻底关闭程序后重新启动')
}

async function invokeRuntime(channel, apiMethod, ...args) {
  if (window.api?.[apiMethod]) {
    return await window.api[apiMethod](...args)
  }

  if (window.electron?.ipcRenderer?.invoke) {
    return await window.electron.ipcRenderer.invoke(channel, ...args)
  }

  throw new Error('当前客户端未注入 Electron 预加载接口，请彻底关闭程序后重新启动')
}

function resolveInvokeError(error, actionLabel) {
  const rawMessage = error?.message || `${actionLabel}失败`

  if (rawMessage.includes("No handler registered for 'bitbrowser:")) {
    return '主进程里的 IPC 接口还没更新到当前版本，请彻底关闭程序和 dev 终端后重新启动'
  }

  return rawMessage
}

function appendLog(message, level = 'INFO') {
  const now = new Date()
  const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate()
  ).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(
    2,
    '0'
  )}:${String(now.getSeconds()).padStart(2, '0')}`

  logLines.value.unshift(`[${timestamp}] [${level}] ${message}`)
}

function appendRuntimeDebug(message) {
  appendLog(`[平台账号调试] ${message}`, 'DEBUG')
}

function handleAutomationLogEntry(entry) {
  const level = entry?.level || 'INFO'
  const entryBrowserId = entry?.browserId || ''
  const browserId = entryBrowserId ? `[${entryBrowserId}] ` : ''
  const message = entry?.message || ''

  if (!message) {
    return
  }

  const accountMatch = message.match(/当前抖音账号[:：]\s*(.+)$/)
  if (entryBrowserId && accountMatch?.[1]) {
    updateBrowserRowUserName(entryBrowserId, accountMatch[1].trim())
  }

  const balanceMatch = message.match(/当前钻石余额[:：]\s*(\d+)/)
  if (entryBrowserId && balanceMatch?.[1]) {
    updateBrowserRowDiamondBalance(entryBrowserId, Number(balanceMatch[1]))
  }

  appendLog(`${browserId}${message}`, level)
}

function normalizeBrowserIdValue(browserId) {
  return String(browserId ?? '').trim().toLowerCase()
}

function rememberRuntimeRowPatch(browserId, patch) {
  if (!patch) {
    return
  }

  const normalizedBrowserId =
    normalizeBrowserIdValue(browserId) ||
    (recentRunBrowserIds.value.length === 1 ? recentRunBrowserIds.value[0] : '')

  if (!normalizedBrowserId) {
    return
  }

  runtimeRowPatches.value = {
    ...runtimeRowPatches.value,
    [normalizedBrowserId]: {
      ...(runtimeRowPatches.value[normalizedBrowserId] || {}),
      ...patch
    }
  }
}

function applyRuntimeRowPatch(row) {
  const normalizedBrowserId = normalizeBrowserIdValue(row?.browserId)
  const patch = runtimeRowPatches.value[normalizedBrowserId]
  return patch ? { ...row, ...patch } : row
}

function replaceBrowserRow(matchedRow, patch) {
  if (!matchedRow || !patch) {
    return
  }

  const rowIndex = browserRows.value.findIndex((row) => row === matchedRow)
  if (rowIndex < 0) {
    return
  }

  const nextRow = {
    ...browserRows.value[rowIndex],
    ...patch
  }

  browserRows.value.splice(rowIndex, 1, nextRow)
}

function resolveTargetBrowserIdForUpdate(browserId) {
  const normalizedBrowserId = normalizeBrowserIdValue(browserId)

  if (
    normalizedBrowserId &&
    browserRows.value.some((row) => normalizeBrowserIdValue(row?.browserId) === normalizedBrowserId)
  ) {
    return normalizedBrowserId
  }

  if (recentRunBrowserIds.value.length === 1) {
    const recentRunBrowserId = recentRunBrowserIds.value[0]
    if (browserRows.value.some((row) => normalizeBrowserIdValue(row?.browserId) === recentRunBrowserId)) {
      return recentRunBrowserId
    }
  }

  if (selectedBrowserRows.value.length === 1) {
    return normalizeBrowserIdValue(selectedBrowserRows.value[0]?.browserId)
  }

  const runningRows = browserRows.value.filter((row) => isBrowserAlreadyRunning(row))
  if (runningRows.length === 1) {
    return normalizeBrowserIdValue(runningRows[0]?.browserId)
  }

  if (browserRows.value.length === 1) {
    return normalizeBrowserIdValue(browserRows.value[0]?.browserId)
  }

  return normalizedBrowserId
}

function resolveBrowserRowForUpdate(browserId) {
  const targetBrowserId = resolveTargetBrowserIdForUpdate(browserId)
  if (!targetBrowserId) {
    return null
  }

  return (
    browserRows.value.find((row) => normalizeBrowserIdValue(row?.browserId) === targetBrowserId) || null
  )
}

function updateBrowserRowUserName(browserId, userName) {
  if (!browserId || !userName) {
    if (!userName) {
      return
    }
  }

  appendRuntimeDebug(
    `收到平台账号更新: browserId=${normalizeBrowserIdValue(browserId) || '(empty)'} userName=${userName}`
  )

  const targetBrowserId = resolveTargetBrowserIdForUpdate(browserId)
  if (!targetBrowserId) {
    appendRuntimeDebug(
      `未解析到目标行: recentRun=${recentRunBrowserIds.value.join(',') || '(empty)'} selected=${selectedBrowserRows.value.length} rows=${browserRows.value.map((row) => normalizeBrowserIdValue(row?.browserId)).join(',') || '(empty)'}`
    )
    rememberRuntimeRowPatch(browserId, {
      userName
    })
    return
  }

  appendRuntimeDebug(`命中目标行: targetBrowserId=${targetBrowserId}`)
  rememberRuntimeRowPatch(targetBrowserId, {
    userName
  })

  const rowIndex = browserRows.value.findIndex(
    (row) => normalizeBrowserIdValue(row?.browserId) === targetBrowserId
  )
  if (rowIndex < 0) {
    appendRuntimeDebug(`命中了 targetBrowserId=${targetBrowserId}，但没有在表格数组中找到对应索引`)
    return
  }

  browserRows.value.splice(rowIndex, 1, {
    ...browserRows.value[rowIndex],
    userName
  })
  appendRuntimeDebug(`已回填平台账号: rowIndex=${rowIndex} browserId=${targetBrowserId} userName=${userName}`)
}

function updateBrowserRowDiamondBalance(browserId, diamondBalance) {
  if (!browserId || !Number.isFinite(diamondBalance)) {
    if (!Number.isFinite(diamondBalance)) {
      return
    }
  }

  const targetBrowserId = resolveTargetBrowserIdForUpdate(browserId)
  if (!targetBrowserId) {
    rememberRuntimeRowPatch(browserId, {
      diamondBalance
    })
    return
  }

  rememberRuntimeRowPatch(targetBrowserId, {
    diamondBalance
  })

  const rowIndex = browserRows.value.findIndex(
    (row) => normalizeBrowserIdValue(row?.browserId) === targetBrowserId
  )
  if (rowIndex < 0) {
    return
  }

  browserRows.value.splice(rowIndex, 1, {
    ...browserRows.value[rowIndex],
    diamondBalance
  })
}

function handleAutomationEventEntry(entry) {
  const entryBrowserId = entry?.browserId || ''
  const browserId = entryBrowserId ? `[${entryBrowserId}] ` : ''
  const type = entry?.type || ''
  const payload = entry?.payload || {}

  if (type === PAGE_AGENT_EVENT_TYPES.ERROR) {
    appendLog(`${browserId}${payload.message || '页面脚本异常'}`, 'ERROR')
    return
  }

  if (type === PAGE_AGENT_EVENT_TYPES.STATUS) {
    const stage = payload?.stage ? `状态: ${payload.stage}` : '状态已更新'
    appendLog(`${browserId}${stage}`)
    return
  }

  if (type === PAGE_AGENT_EVENT_TYPES.FLOW && payload?.result?.status) {
    appendLog(`${browserId}流程结果: ${payload.result.status}`)
    return
  }

  if (type === PAGE_AGENT_EVENT_TYPES.ACCOUNT && payload?.accountName) {
    updateBrowserRowUserName(entryBrowserId, payload.accountName)
    return appendLog(`${browserId}当前平台账号: ${payload.accountName}`)
    appendLog(`${browserId}当前平台账号: ${payload.nickName}`)
    return
  }

  if (type === PAGE_AGENT_EVENT_TYPES.BALANCE && Number.isFinite(payload?.diamondBalance)) {
    updateBrowserRowDiamondBalance(entryBrowserId, payload.diamondBalance)
    appendLog(`${browserId}当前钻石余额: ${payload.diamondBalance}`)
    return
  }

  if (type === PAGE_AGENT_EVENT_TYPES.LUCKY_BAG && Number.isFinite(payload?.diamondCount)) {
    appendLog(`${browserId}检测到福袋钻石数: ${payload.diamondCount}`)
  }
}

function parseAccountNameFromMessage(message) {
  const source = String(message || '')
  const match =
    source.match(/当前抖音账号[:：]\s*(.+)$/) ||
    source.match(/当前平台账号[:：]\s*(.+)$/) ||
    source.match(/褰撳墠.*璐﹀彿[:：]\s*(.+)$/)

  return match?.[1]?.trim() || ''
}

function parseDiamondBalanceFromMessage(message) {
  const source = String(message || '')
  const match =
    source.match(/当前钻石余额[:：]\s*(\d+)/) ||
    source.match(/褰撳墠.*浣欓[:：]\s*(\d+)/)

  if (!match?.[1]) {
    return null
  }

  const parsed = Number(match[1])
  return Number.isFinite(parsed) ? parsed : null
}

function handleAutomationLogEntryV2(entry) {
  const level = entry?.level || 'INFO'
  const entryBrowserId = entry?.browserId || ''
  const browserId = entryBrowserId ? `[${entryBrowserId}] ` : ''
  const message = entry?.message || ''

  if (!message) {
    return
  }

  const accountName = parseAccountNameFromMessage(message)
  if (accountName) {
    appendRuntimeDebug(
      `日志命中平台账号: browserId=${normalizeBrowserIdValue(entryBrowserId) || '(empty)'} accountName=${accountName}`
    )
    updateBrowserRowUserName(entryBrowserId, accountName)
  }

  const diamondBalance = parseDiamondBalanceFromMessage(message)
  if (Number.isFinite(diamondBalance)) {
    updateBrowserRowDiamondBalance(entryBrowserId, diamondBalance)
  }

  appendLog(`${browserId}${message}`, level)
}

function handleAutomationEventEntryV2(entry) {
  const entryBrowserId = entry?.browserId || ''
  const browserId = entryBrowserId ? `[${entryBrowserId}] ` : ''
  const type = entry?.type || ''
  const payload = entry?.payload || {}

  if (type === PAGE_AGENT_EVENT_TYPES.LOG && payload?.message) {
    const accountName = parseAccountNameFromMessage(payload.message)
    if (accountName) {
      appendRuntimeDebug(
        `LOG 事件命中平台账号: browserId=${normalizeBrowserIdValue(entryBrowserId) || '(empty)'} accountName=${accountName}`
      )
      updateBrowserRowUserName(entryBrowserId, accountName)
    }

    const diamondBalance = parseDiamondBalanceFromMessage(payload.message)
    if (Number.isFinite(diamondBalance)) {
      updateBrowserRowDiamondBalance(entryBrowserId, diamondBalance)
    }

    appendLog(`${browserId}${payload.message}`)
    return
  }

  if (type === PAGE_AGENT_EVENT_TYPES.ERROR) {
    appendLog(`${browserId}${payload.message || '页面脚本异常'}`, 'ERROR')
    return
  }

  if (type === PAGE_AGENT_EVENT_TYPES.STATUS) {
    const stage = payload?.stage ? `状态: ${payload.stage}` : '状态已更新'
    appendLog(`${browserId}${stage}`)
    return
  }

  if (type === PAGE_AGENT_EVENT_TYPES.FLOW && payload?.result?.status) {
    appendLog(`${browserId}流程结果: ${payload.result.status}`)
    return
  }

  if (type === PAGE_AGENT_EVENT_TYPES.ACCOUNT && payload?.accountName) {
    appendRuntimeDebug(
      `ACCOUNT 事件命中平台账号: browserId=${normalizeBrowserIdValue(entryBrowserId) || '(empty)'} accountName=${payload.accountName}`
    )
    updateBrowserRowUserName(entryBrowserId, payload.accountName)
    appendLog(`${browserId}当前平台账号: ${payload.accountName}`)
    return
  }

  if (type === PAGE_AGENT_EVENT_TYPES.BALANCE && Number.isFinite(payload?.diamondBalance)) {
    updateBrowserRowDiamondBalance(entryBrowserId, payload.diamondBalance)
    appendLog(`${browserId}当前钻石余额: ${payload.diamondBalance}`)
    return
  }

  if (type === PAGE_AGENT_EVENT_TYPES.LUCKY_BAG && Number.isFinite(payload?.diamondCount)) {
    appendLog(`${browserId}检测到福袋钻石数: ${payload.diamondCount}`)
  }
}

function readField(record, keys, fallback = '') {
  for (const key of keys) {
    const value = record?.[key]
    if (value !== undefined && value !== null && value !== '') {
      return value
    }
  }

  return fallback
}

function normalizeStatus(record) {
  const status = readField(record, ['status', 'browserStatus', 'openState', 'state'])

  if (typeof status === 'number') {
    const statusMap = {
      0: '未打开',
      1: '运行中',
      2: '已关闭',
      3: '异常'
    }

    return statusMap[status] ?? String(status)
  }

  return status || '未知'
}

function normalizeBrowserRow(record, index) {
  const proxy = record?.proxy || {}

  return {
    seq: readField(record, ['seq', 'serialNo', 'sortNum'], index + 1),
    browserId: readField(record, ['id', 'browserId', 'profileId']),
    status: normalizeStatus(record),
    name: readField(record, ['name'], '-'),
    remark: readField(record, ['remark', 'notes'], '-'),
    groupName: readField(record, ['groupName', 'groupId'], '-'),
    userName: readField(record, ['userName', 'platformUserName', 'account', 'nickname'], '-'),
    diamondBalance: readField(record, ['diamondBalance', 'balance'], '-'),
    proxyType: readField(record, ['proxyType'], readField(proxy, ['proxyType'], '-')),
    proxyHost: readField(record, ['host'], readField(proxy, ['host'], '-')),
    proxyPort: readField(record, ['port'], readField(proxy, ['port'], '-')),
    platform: readField(record, ['platform', 'platformIcon'], '-'),
    
    raw: record
  }
}

function isBrowserAlreadyRunning(row) {
  const rawStatus = row?.raw?.status ?? row?.raw?.browserStatus ?? row?.raw?.openState ?? row?.raw?.state
  if (rawStatus === 1 || rawStatus === '1') {
    return true
  }

  const statusText = String(row?.status || '')
  return statusText.includes('运行')
}

function handleSelectionChange(selection) {
  selectedBrowserRows.value = selection
}

async function refreshRuntimeMetrics() {
  try {
    const metrics = await invokeRuntime('app:metrics', 'getRuntimeMetrics')
    runtimeMetrics.value = {
      cpuPercent: metrics?.cpuPercent ?? 0,
      memoryPercent: metrics?.memoryPercent ?? 0,
      memoryUsedMB: metrics?.memoryUsedMB ?? 0,
      automationCount: metrics?.automationCount ?? 0
    }
  } catch {
    runtimeMetrics.value = {
      cpuPercent: 0,
      memoryPercent: 0,
      memoryUsedMB: 0,
      automationCount: 0
    }
  }
}

async function fetchBrowserWindowInfo(showSuccessMessage = true) {
  isLoadingBrowsers.value = true
  appendLog('开始获取比特浏览器窗口信息')

  try {
    const response = await invokeBitBrowser('bitbrowser:list', 'getBitBrowserList')
    const nextRows = (response?.items || []).map(normalizeBrowserRow).map(applyRuntimeRowPatch)
    nextRows.sort((a, b) => Number.parseInt(a.seq, 10) - Number.parseInt(b.seq, 10))
    browserRows.value = nextRows

    const apiBaseUrl = response?.apiBaseUrl || 'http://127.0.0.1:54345'
    appendLog(`获取成功，共 ${browserRows.value.length} 个浏览器窗口，接口地址: ${apiBaseUrl}`)
    if (showSuccessMessage) {
      ElMessage.success(`已获取 ${browserRows.value.length} 个浏览器窗口`)
    }
  } catch (error) {
    const message = resolveInvokeError(error, '获取比特浏览器窗口信息')
    appendLog(message, 'ERROR')
    ElMessage.error(message)
  } finally {
    isLoadingBrowsers.value = false
  }
}

async function arrangeWindows() {
  isArrangingWindows.value = true
  appendLog('开始执行一键排列窗口')

  try {
    await invokeBitBrowser('bitbrowser:arrange', 'arrangeBitBrowserWindows')
    appendLog('一键排列窗口执行成功')
    ElMessage.success('窗口排列完成')
  } catch (error) {
    const message = resolveInvokeError(error, '一键排列窗口')
    appendLog(message, 'ERROR')
    ElMessage.error(message)
  } finally {
    isArrangingWindows.value = false
  }
}

async function closeAllWindows() {
  isClosingWindows.value = true
  appendLog('开始关闭所有窗口')

  try {
    const result = await invokeBitBrowser('bitbrowser:close-all', 'closeAllBitBrowserWindows')
    const closedCount = result?.closedCount ?? 0
    appendLog(`关闭所有窗口完成，本次处理 ${closedCount} 个窗口`)
    ElMessage.success(`已处理 ${closedCount} 个窗口`)
    await fetchBrowserWindowInfo()
  } catch (error) {
    const message = resolveInvokeError(error, '关闭所有窗口')
    appendLog(message, 'ERROR')
    ElMessage.error(message)
  } finally {
    isClosingWindows.value = false
  }
}

async function startRun() {
  if (!browserRows.value.length) {
    const message = '请先点击“获取所有浏览器窗口信息”'
    appendLog(message, 'WARN')
    ElMessage.warning(message)
    return
  }

  if (!selectedBrowserRows.value.length) {
    const message = '请先在表格里勾选要打开的浏览器窗口'
    appendLog(message, 'WARN')
    ElMessage.warning(message)
    return
  }

  const browserIds = selectedBrowserRows.value
    .filter((row) => !isBrowserAlreadyRunning(row))
    .map((item) => item?.browserId)
    .filter((id) => typeof id === 'string' && id.trim() !== '')

  if (!browserIds.length) {
    const message = '当前勾选项里没有可打开的浏览器ID'
    appendLog(message, 'WARN')
    ElMessage.warning(message)
    return
  }

  isStartingRun.value = true
  recentRunBrowserIds.value = browserIds.map((id) => normalizeBrowserIdValue(id)).filter(Boolean)
  appendLog(`开始运行，已勾选 ${selectedBrowserRows.value.length} 个，准备打开 ${browserIds.length} 个比特浏览器窗口`)

  try {
    const result = await invokeRuntime('douyin:start', 'startDouyinRun', {
      browserIds,
      options: {
        diamondRange: form.value.diamondRange,
        entranceUrl: 'https://www.douyin.com',
        recommendUrl: 'https://www.douyin.com'
      }
    })
    const openedCount = result?.startedCount ?? 0
    const failedCount = result?.failedCount ?? 0
    const skippedCount = result?.skippedCount ?? 0

    if (failedCount > 0) {
      const message = `已启动 ${openedCount} 个自动流程，失败 ${failedCount} 个${skippedCount > 0 ? `，跳过 ${skippedCount} 个` : ''}`
      appendLog(message, 'WARN')
      ElMessage.warning(message)
    } else {
      const message = `开始运行成功，已启动 ${openedCount} 个抖音福袋自动流程${skippedCount > 0 ? `，跳过 ${skippedCount} 个` : ''}`
      appendLog(message)
      ElMessage.success(message)
    }

    await refreshRuntimeMetrics()
    await fetchBrowserWindowInfo(false)
  } catch (error) {
    const message = resolveInvokeError(error, '开始运行')
    appendLog(message, 'ERROR')
    ElMessage.error(message)
  } finally {
    isStartingRun.value = false
  }
}

async function stopRun() {
  if (!selectedBrowserRows.value.length) {
    const message = '请先在表格里勾选要停止的浏览器窗口'
    appendLog(message, 'WARN')
    ElMessage.warning(message)
    return
  }

  const browserIds = selectedBrowserRows.value
    .map((item) => item?.browserId)
    .filter((id) => typeof id === 'string' && id.trim() !== '')

  if (!browserIds.length) {
    const message = '当前勾选项里没有可停止的浏览器ID'
    appendLog(message, 'WARN')
    ElMessage.warning(message)
    return
  }

  isStoppingRun.value = true
  appendLog(`开始停止运行，目标浏览器 ${browserIds.length} 个`)

  try {
    const result = await invokeRuntime('douyin:stop', 'stopDouyinRun', {
      browserIds
    })
    const stoppedCount = result?.stoppedCount ?? 0
    const closedCount = result?.closedCount ?? 0
    const failedCount = (result?.stopFailedCount ?? 0) + (result?.closeFailedCount ?? 0)
    const message =
      failedCount > 0
        ? `已停止 ${stoppedCount} 个自动流程，已关闭 ${closedCount} 个浏览器，失败 ${failedCount} 个`
        : `已停止 ${stoppedCount} 个自动流程，已关闭 ${closedCount} 个浏览器`
    appendLog(message, failedCount > 0 ? 'WARN' : 'INFO')
    if (failedCount > 0) {
      ElMessage.warning(message)
    } else {
      ElMessage.success(message)
    }

    await refreshRuntimeMetrics()
    await fetchBrowserWindowInfo(false)
    selectedBrowserRows.value = []
    await nextTick()
    browserTableRef.value?.clearSelection?.()
  } catch (error) {
    const message = resolveInvokeError(error, '停止运行')
    appendLog(message, 'ERROR')
    ElMessage.error(message)
  } finally {
    isStoppingRun.value = false
  }
}

function clearLogs() {
  logLines.value = ['[INFO] 日志已清空']
}

onMounted(() => {
  refreshRuntimeMetrics()
  metricsTimer = window.setInterval(refreshRuntimeMetrics, 2000)

  if (window.api?.onAutomationLog) {
    disposeAutomationLog = window.api.onAutomationLog(handleAutomationLogEntryV2)
  }

  if (window.api?.onAutomationEvent) {
    disposeAutomationEvent = window.api.onAutomationEvent(handleAutomationEventEntryV2)
  }
})

onBeforeUnmount(() => {
  if (metricsTimer) {
    window.clearInterval(metricsTimer)
    metricsTimer = null
  }

  if (disposeAutomationLog) {
    disposeAutomationLog()
    disposeAutomationLog = null
  }

  if (disposeAutomationEvent) {
    disposeAutomationEvent()
    disposeAutomationEvent = null
  }
})
</script>



<style scoped>
.desktop-shell {
  height: 100vh;
  overflow: hidden;
  background: #dfe7f0;
  color: #2a2f36;
  font-family: 'Microsoft YaHei', 'PingFang SC', sans-serif;
}

.workspace {
  display: flex;
  flex-direction: column;
  gap: 4px;
  height: 100%;
  min-height: 0;
  padding: 6px;
  overflow: hidden;
}

.panel {
  background: #f4f6f8;
  border: 1px solid #cfd8e3;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.8);
}

.controls-panel {
  padding: 6px 10px 0;
  background: #f7f7f7;
}

.action-row {
  display: flex;
  gap: 12px;
  margin-bottom: 10px;
}

.action-btn {
  min-width: 142px;
  height: 36px;
  border: 0;
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.24);
  cursor: pointer;
}

.action-btn:disabled {
  cursor: wait;
  opacity: 0.75;
}

.is-green {
  background: #46cc62;
}

.is-purple {
  background: #ba5be6;
}

.is-deep-purple {
  background: #8f59d9;
}

.is-green-alt {
  background: #4cc458;
}

.is-red {
  background: #ff4a35;
}

.form-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 8px;
  flex-wrap: wrap;
  font-size: 12px;
}

.form-row--subtle {
  padding: 6px 10px;
  margin: 0 -10px;
  background: #eaf4ff;
  border-top: 1px solid #d7e7f8;
}

.field {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.field label {
  color: #333;
  white-space: nowrap;
}

.field.compact :deep(.el-input) {
  width: 50px;
}

.field.wide :deep(.el-input) {
  width: 72px;
}

.select-field :deep(.el-select) {
  width: 92px;
}

.mode-label {
  color: #2280d8;
  font-weight: 700;
}

.check-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #2f3439;
}

.check-item input {
  width: 12px;
  height: 12px;
}

.tab-row {
  display: flex;
  align-items: flex-end;
  gap: 1px;
  padding: 4px 6px 0;
  background: #f0f0f0;
  border-bottom: 1px solid #cdd6de;
}

.tab-btn {
  padding: 4px 10px;
  border: 1px solid #cdd6de;
  border-bottom: 0;
  background: #f7f7f7;
  color: #444;
  font-size: 12px;
  cursor: pointer;
}

.tab-btn.is-active {
  background: #fff;
  color: #2d2d2d;
}

.table-panel {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  background: #fff;
  overflow: hidden;
}

.table-wrap {
  flex: 1;
  min-height: 0;
  padding: 4px 6px 6px;
  overflow: hidden;
}

.browser-table {
  --el-table-border-color: #dde2e9;
  --el-table-header-bg-color: #fff;
  --el-table-row-hover-bg-color: #f7fbff;
  --el-table-text-color: #363b44;
  --el-table-header-text-color: #33373c;
  font-size: 12px;
}

.browser-table :deep(th.el-table__cell) {
  background: #fff;
  padding: 4px 0;
}

.browser-table :deep(td.el-table__cell) {
  padding: 2px 0;
}

.bottom-section {
  display: grid;
  flex: 0 0 188px;
  grid-template-columns: minmax(0, 1fr) 290px;
  gap: 8px;
  min-height: 0;
}

.logs-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: #fff;
}

.logs-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 5px 8px;
  border-bottom: 1px solid #d7dde5;
  font-size: 12px;
  flex-wrap: wrap;
}

.metrics {
  color: #58a9ff;
}

.muted-text {
  color: #7a8087;
}

.output-title {
  color: #000;
  font-weight: 700;
}

.warning-text {
  margin-left: auto;
  color: #ff563d;
  font-size: 11px;
}

.logs-content {
  position: relative;
  flex: 1;
  min-height: 0;
  padding: 8px 10px;
  background: #fff;
}

.logs-content pre {
  height: 100%;
  overflow: auto;
  font-family: 'Consolas', 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.45;
  color: #2c3442;
  white-space: pre-wrap;
}

.ghost-btn {
  position: absolute;
  top: 8px;
  right: 8px;
  padding: 5px 10px;
  border: 1px solid #bfc7d1;
  background: #efefef;
  color: #666;
  font-size: 12px;
  cursor: pointer;
}

.result-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 10px;
  background: #fff;
}

.summary-line {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-bottom: 10px;
  font-size: 14px;
  font-weight: 700;
}

.summary.success {
  color: #2ea84d;
}

.summary.primary {
  color: #2073d8;
}

.result-box {
  flex: 1;
  border: 1px solid #d9c8c8;
  background: #fff4f4;
}

.result-title {
  padding: 8px 8px 4px;
  color: #d65b4a;
  font-size: 13px;
  font-weight: 700;
}

.result-text {
  padding: 0 8px 8px;
  color: #7b5950;
  font-size: 12px;
  line-height: 1.5;
}

:deep(.el-input__wrapper),
:deep(.el-select__wrapper) {
  min-height: 22px;
  border-radius: 0;
  box-shadow: 0 0 0 1px #cfd5dd inset;
}

:deep(.el-input__inner),
:deep(.el-select__selected-item) {
  font-size: 12px;
  color: #30343a;
}

@media (max-width: 1200px) {
  .bottom-section {
    grid-template-columns: 1fr;
  }

  .warning-text {
    margin-left: 0;
  }
}
</style>
