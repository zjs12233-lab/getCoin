import { shell } from 'electron'
import { optimizer, is } from '@electron-toolkit/utils'

function isDevToolsShortcut(input) {
  return (
    input.code === 'F12' ||
    (input.code === 'KeyI' && ((input.control && input.shift) || (input.meta && input.alt)))
  )
}

function isReloadShortcut(input) {
  return input.code === 'F5' || (input.code === 'KeyR' && (input.control || input.meta))
}

function isZoomShortcut(input) {
  const isModifierPressed = input.control || input.meta
  return (
    isModifierPressed &&
    (input.code === 'Minus' ||
      input.code === 'Equal' ||
      input.code === 'NumpadAdd' ||
      input.code === 'NumpadSubtract' ||
      input.code === 'Digit0' ||
      input.code === 'Numpad0')
  )
}

function shouldBlockShortcut(input) {
  return isDevToolsShortcut(input) || isReloadShortcut(input) || isZoomShortcut(input)
}

export function createSecureWebPreferences(overrides = {}) {
  return {
    ...overrides,
    devTools: is.dev
  }
}

export function configureWindowSecurity(window) {
  if (!window) {
    return
  }

  optimizer.watchWindowShortcuts(window)

  if (!is.dev) {
    window.removeMenu()
    window.setMenuBarVisibility(false)
  }

  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  window.webContents.on('context-menu', (event) => {
    if (!is.dev) {
      event.preventDefault()
    }
  })

  window.webContents.on('before-input-event', (event, input) => {
    if (is.dev || input.type !== 'keyDown') {
      return
    }

    if (shouldBlockShortcut(input)) {
      event.preventDefault()
    }
  })
}
