importScripts("core.js")

const MENU_ID = "deleto-create-share"

async function registerContextMenu() {
  await chrome.contextMenus.removeAll()
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "Create encrypted Dele.to share",
    contexts: ["selection"],
  })
}

function badgeTarget(tabId, text) {
  return Number.isInteger(tabId) ? { tabId, text } : { text }
}

async function setStatus(status, tabId) {
  const value = { ...status, timestamp: Date.now() }
  await chrome.storage.session.set({ lastStatus: value })
  const badge = status.state === "creating" ? "…" : status.state === "success" ? "OK" : "!"
  const color = status.state === "creating" ? "#475569" : status.state === "success" ? "#059669" : "#dc2626"
  await chrome.action.setBadgeBackgroundColor(Number.isInteger(tabId) ? { tabId, color } : { color })
  await chrome.action.setBadgeText(badgeTarget(tabId, badge))
  return value
}

async function showPageStatus(tabId, state, message) {
  if (!Number.isInteger(tabId)) return
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (statusState, statusMessage) => {
        const existing = document.getElementById("deleto-extension-status")
        if (existing) existing.remove()
        const status = document.createElement("div")
        status.id = "deleto-extension-status"
        status.textContent = statusMessage
        Object.assign(status.style, {
          position: "fixed",
          zIndex: "2147483647",
          right: "20px",
          bottom: "20px",
          maxWidth: "360px",
          padding: "12px 16px",
          borderRadius: "10px",
          color: "white",
          background: statusState === "success" ? "#059669" : statusState === "creating" ? "#334155" : "#dc2626",
          boxShadow: "0 12px 32px rgba(0,0,0,.28)",
          font: "600 14px/1.4 system-ui, sans-serif",
        })
        document.documentElement.appendChild(status)
        if (statusState !== "creating") setTimeout(() => status.remove(), 5000)
      },
      args: [state, message],
    })
  } catch {
  }
}

async function ensureOffscreenDocument() {
  const documentUrl = chrome.runtime.getURL("offscreen.html")
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [documentUrl],
    })
    if (contexts.length > 0) return
  }
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["CLIPBOARD"],
      justification: "Copy the locally assembled encrypted share URL",
    })
  } catch (error) {
    if (!String(error).includes("single offscreen document")) throw error
  }
}

async function copyLink(text) {
  await ensureOffscreenDocument()
  const result = await chrome.runtime.sendMessage({ target: "offscreen", type: "copy", text })
  if (!result?.ok) throw new Error(result?.error || "Could not copy the link")
}

async function getSettings() {
  const stored = await chrome.storage.local.get("settings")
  return { ...DeletoCore.DEFAULT_SETTINGS, ...(stored.settings || {}) }
}

async function selectedTextFromTab(tab) {
  if (!tab?.id) throw new Error("Open a page and select text to share")
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: DeletoCore.readSelectedText,
    })
    return results.find((entry) => entry.result)?.result || ""
  } catch {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: DeletoCore.readSelectedText,
      })
      return results[0]?.result || ""
    } catch {
      throw new Error("Chrome blocks selection access on this page — paste the text into the extension instead")
    }
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab
}

function retryMessage(seconds) {
  if (!Number.isFinite(seconds) || seconds < 1) return ""
  const minutes = Math.ceil(seconds / 60)
  return ` Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`
}

async function createShare(text, tab, overrides = {}) {
  const tabId = tab?.id
  if (typeof text !== "string" || text.length === 0) {
    const status = await setStatus({ state: "error", message: "Select text before creating a share" }, tabId)
    await showPageStatus(tabId, status.state, status.message)
    return status
  }

  const settings = await getSettings()
  if (Number.isInteger(overrides.expiresIn)) settings.expiresIn = overrides.expiresIn
  if (Number.isInteger(overrides.maxViews)) settings.maxViews = overrides.maxViews
  const authMode = settings.apiKey ? "api_key" : "anonymous"
  const creatingMessage = authMode === "api_key" ? "Encrypting and creating share with API key…" : "Encrypting and creating anonymous share…"
  await setStatus({ state: "creating", message: creatingMessage, authMode }, tabId)
  await showPageStatus(tabId, "creating", creatingMessage)
  try {
    const result = await DeletoCore.createEncryptedShare(text, settings)
    try {
      await copyLink(result.url)
      const successMessage = authMode === "api_key" ? "Share created with API key — link copied" : "Anonymous share created — link copied"
      const status = await setStatus({ state: "success", message: successMessage, url: result.url, authMode }, tabId)
      await showPageStatus(tabId, status.state, status.message)
      return status
    } catch {
      const status = await setStatus({
        state: "error",
        message: "Share created, but the link could not be copied",
        url: result.url,
        authMode,
      }, tabId)
      await showPageStatus(tabId, status.state, status.message)
      return status
    }
  } catch (error) {
    let message = DeletoCore.friendlyShareError(error, authMode)
    if (error?.code === "rate_limit" && message === "Creation quota exceeded") {
      message = authMode === "api_key" ? "Creation quota exceeded for this account" : "Anonymous creation quota exceeded — add an API key in extension settings"
    }
    if (error?.code === "rate_limit") message += retryMessage(error.retryAfter)
    const status = await setStatus({ state: "error", message, code: error?.code, authMode }, tabId)
    await showPageStatus(tabId, status.state, status.message)
    return status
  }
}

chrome.runtime.onInstalled.addListener(() => {
  registerContextMenu().catch(() => {})
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID) createShare(info.selectionText || "", tab).catch(() => {})
})

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "share-selection") return
  const tab = await activeTab()
  try {
    await createShare(await selectedTextFromTab(tab), tab)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read selected text"
    await setStatus({ state: "error", message }, tab?.id)
    await showPageStatus(tab?.id, "error", message)
  }
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target === "offscreen") return false
  const handle = async () => {
    if (message.type === "get-state") {
      const tab = await activeTab()
      let selection = ""
      let selectionError = ""
      try {
        selection = await selectedTextFromTab(tab)
      } catch (error) {
        selectionError = error instanceof Error ? error.message : "Could not read selected text"
      }
      const [{ lastStatus = null }, settings] = await Promise.all([
        chrome.storage.session.get("lastStatus"),
        getSettings(),
      ])
      return { selection, selectionError, lastStatus, settings }
    }
    if (message.type === "create-share") {
      return createShare(message.text, await activeTab(), {
        expiresIn: message.expiresIn,
        maxViews: message.maxViews,
      })
    }
    if (message.type === "settings-updated") {
      const settings = await getSettings()
      return { ok: true, authMode: settings.apiKey ? "api_key" : "anonymous" }
    }
    throw new Error("Unknown extension message")
  }
  handle().then(sendResponse).catch((error) => sendResponse({
    state: "error",
    message: error instanceof Error ? error.message : "Extension request failed",
  }))
  return true
})
