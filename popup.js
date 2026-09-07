const textInput = document.getElementById("share-text")
const createButton = document.getElementById("create")
const selectionHint = document.getElementById("selection-hint")
const statusElement = document.getElementById("status")
const statusTitle = document.getElementById("status-title")
const statusMessage = document.getElementById("status-message")
const linkRow = document.getElementById("link-row")
const shareLink = document.getElementById("share-link")
const copyButton = document.getElementById("copy")
const serverInput = document.getElementById("server")
const apiKeyInput = document.getElementById("api-key")
const expirationInput = document.getElementById("expiration")
const maxViewsInput = document.getElementById("max-views")
const saveServerButton = document.getElementById("save-server")
const serverStatus = document.getElementById("server-status")
const shortcutElement = document.getElementById("shortcut")
const inlineShortcutElement = document.getElementById("shortcut-inline")
const changeShortcutButton = document.getElementById("change-shortcut")

function setupDropdown(input) {
  const root = input.closest("[data-dropdown]")
  if (!root) return null
  const trigger = root.querySelector("[data-dropdown-trigger]")
  const label = root.querySelector("[data-dropdown-label]")
  const menu = root.querySelector("[role='listbox']")
  const options = [...root.querySelectorAll("[role='option']")]

  const close = () => {
    menu.hidden = true
    trigger.setAttribute("aria-expanded", "false")
  }
  const open = () => {
    document.querySelectorAll("[data-dropdown-trigger][aria-expanded='true']").forEach((other) => {
      if (other !== trigger) {
        other.setAttribute("aria-expanded", "false")
        other.closest("[data-dropdown]").querySelector("[role='listbox']").hidden = true
      }
    })
    menu.hidden = false
    trigger.setAttribute("aria-expanded", "true")
  }
  const setValue = (value, emit = false) => {
    const selected = options.find((option) => option.dataset.value === String(value)) || options[0]
    input.value = selected.dataset.value
    label.innerHTML = selected.querySelector(".option-label").innerHTML
    options.forEach((option) => option.setAttribute("aria-selected", String(option === selected)))
    if (emit) input.dispatchEvent(new Event("change"))
  }

  trigger.addEventListener("click", (event) => {
    event.stopPropagation()
    if (menu.hidden) open()
    else close()
  })
  trigger.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "Enter", " "].includes(event.key)) return
    event.preventDefault()
    open()
    ;(options.find((option) => option.getAttribute("aria-selected") === "true") || options[0]).focus()
  })
  options.forEach((option, index) => {
    option.addEventListener("click", (event) => {
      event.stopPropagation()
      setValue(option.dataset.value, true)
      close()
      trigger.focus()
    })
    option.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        close()
        trigger.focus()
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        const offset = event.key === "ArrowDown" ? 1 : -1
        options[(index + offset + options.length) % options.length].focus()
      }
    })
  })
  document.addEventListener("click", close)
  setValue(input.value)
  return { setValue }
}

const expirationDropdown = setupDropdown(expirationInput)
const maxViewsDropdown = setupDropdown(maxViewsInput)

function renderStatus(status) {
  if (!status) return
  statusElement.classList.remove("hidden")
  statusElement.dataset.state = status.state
  const adjustable = status.code === "expiry_limit" || status.code === "view_limit"
  statusTitle.textContent = status.state === "success"
    ? "Ready"
    : status.state === "creating"
      ? "Working"
      : adjustable
        ? "Adjust share settings"
        : "Could not finish"
  statusMessage.textContent = status.message || ""
  createButton.disabled = status.state === "creating"
  createButton.textContent = status.state === "creating" ? "Creating…" : "Create encrypted share"
  if (status.url) {
    const copied = status.state === "success" && /link copied/i.test(status.message || "")
    shareLink.value = status.url
    copyButton.textContent = copied ? "Copied" : "Copy"
    copyButton.dataset.copied = String(copied)
    linkRow.classList.remove("hidden")
  } else {
    shareLink.value = ""
    copyButton.textContent = "Copy"
    copyButton.dataset.copied = "false"
    linkRow.classList.add("hidden")
  }
}

async function loadState() {
  const state = await chrome.runtime.sendMessage({ type: "get-state" })
  if (state.selection) textInput.value = state.selection
  selectionHint.textContent = state.selectionError || (state.selection ? "Selection loaded from this page." : "Select text on the page or paste it here.")
  serverInput.value = state.settings?.serverUrl || DeletoCore.DEFAULT_SETTINGS.serverUrl
  apiKeyInput.value = state.settings?.apiKey || ""
  const expiresIn = String(state.settings?.expiresIn || DeletoCore.DEFAULT_SETTINGS.expiresIn)
  const maxViews = String(state.settings?.maxViews || DeletoCore.DEFAULT_SETTINGS.maxViews)
  if (expirationDropdown) expirationDropdown.setValue(expiresIn)
  else expirationInput.value = expiresIn
  if (maxViewsDropdown) maxViewsDropdown.setValue(maxViews)
  else maxViewsInput.value = maxViews
  renderStatus(state.lastStatus)
  const commands = await chrome.commands.getAll()
  const command = commands.find((entry) => entry.name === "share-selection")
  const shortcut = command?.shortcut || "Not assigned"
  shortcutElement.textContent = shortcut
  inlineShortcutElement.textContent = shortcut
}

createButton.addEventListener("click", async () => {
  if (!textInput.value) {
    renderStatus({ state: "error", message: "Select text or enter text to share" })
    return
  }
  renderStatus({ state: "creating", message: "Encrypting locally and creating share…" })
  const status = await chrome.runtime.sendMessage({
    type: "create-share",
    text: textInput.value,
    expiresIn: Number(expirationInput.value),
    maxViews: Number(maxViewsInput.value),
  })
  renderStatus(status)
})

copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(shareLink.value)
    copyButton.textContent = "Copied"
    copyButton.dataset.copied = "true"
  } catch {
    copyButton.textContent = "Failed"
    copyButton.dataset.copied = "false"
  }
})

async function persistShareOptions() {
  const stored = await chrome.storage.local.get("settings")
  const settings = {
    ...DeletoCore.DEFAULT_SETTINGS,
    ...(stored.settings || {}),
    expiresIn: Number(expirationInput.value),
    maxViews: Number(maxViewsInput.value),
  }
  await chrome.storage.local.set({ settings })
}

expirationInput.addEventListener("change", () => persistShareOptions().catch(() => {}))
maxViewsInput.addEventListener("change", () => persistShareOptions().catch(() => {}))

saveServerButton.addEventListener("click", async () => {
  saveServerButton.disabled = true
  serverStatus.textContent = "Checking site access…"
  try {
    const serverUrl = DeletoCore.normalizeServerUrl(serverInput.value)
    const apiKey = DeletoCore.normalizeApiKey(apiKeyInput.value)
    const parsedServer = new URL(serverUrl)
    const origin = `${parsedServer.protocol}//${parsedServer.hostname}/*`
    const allowed = await chrome.permissions.contains({ origins: [origin] })
    if (!allowed) {
      const granted = await chrome.permissions.request({ origins: [origin] })
      if (!granted) throw new Error("Site access was not granted")
    }
    const settings = {
      ...DeletoCore.DEFAULT_SETTINGS,
      serverUrl,
      apiKey,
      expiresIn: Number(expirationInput.value),
      maxViews: Number(maxViewsInput.value),
    }
    await chrome.storage.local.set({ settings })
    const activation = await chrome.runtime.sendMessage({ type: "settings-updated" })
    serverInput.value = serverUrl
    apiKeyInput.value = apiKey
    serverStatus.textContent = apiKey && activation?.authMode !== "api_key"
      ? "API key saved. Reload the unpacked extension to activate it."
      : apiKey
        ? "API key saved and active. New shares use your account quota."
        : "Settings saved. New shares use the anonymous quota."
  } catch (error) {
    serverStatus.textContent = error instanceof Error ? error.message : "Could not save server"
  } finally {
    saveServerButton.disabled = false
  }
})

changeShortcutButton.addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" })
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.lastStatus) renderStatus(changes.lastStatus.newValue)
})

loadState().catch((error) => {
  renderStatus({ state: "error", message: error instanceof Error ? error.message : "Could not load extension" })
})
