import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { AUTOMATION_EVENT_CHANNEL, AUTOMATION_LOG_CHANNEL } from '../shared/automationProtocol'

const api = {
  getRuntimeMetrics: () => ipcRenderer.invoke('app:metrics'),
  getBitBrowserList: () => ipcRenderer.invoke('bitbrowser:list'),
  arrangeBitBrowserWindows: () => ipcRenderer.invoke('bitbrowser:arrange'),
  closeAllBitBrowserWindows: () => ipcRenderer.invoke('bitbrowser:close-all'),
  openBitBrowserWindows: (browserIds) => ipcRenderer.invoke('bitbrowser:open', browserIds),
  startDouyinRun: (payload) => ipcRenderer.invoke('douyin:start', payload),
  stopDouyinRun: (payload) => ipcRenderer.invoke('douyin:stop', payload),
  onAutomationLog: (callback) => {
    if (typeof callback !== 'function') {
      return () => {}
    }

    const listener = (_, payload) => callback(payload)
    ipcRenderer.on(AUTOMATION_LOG_CHANNEL, listener)
    return () => ipcRenderer.off(AUTOMATION_LOG_CHANNEL, listener)
  },
  onAutomationEvent: (callback) => {
    if (typeof callback !== 'function') {
      return () => {}
    }

    const listener = (_, payload) => callback(payload)
    ipcRenderer.on(AUTOMATION_EVENT_CHANNEL, listener)
    return () => ipcRenderer.off(AUTOMATION_EVENT_CHANNEL, listener)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  window.electron = electronAPI
  window.api = api
}
