(function (root, factory) {
  const api = factory()
  if (typeof module === "object" && module.exports) module.exports = api
  root.DeletoCore = api
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict"

  const DEFAULT_SETTINGS = Object.freeze({
    serverUrl: "https://dele.to",
    apiKey: "",
    expiresIn: 3600,
    maxViews: 1,
  })

  function bytesToBase64(bytes) {
    let binary = ""
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
    }
    return btoa(binary)
  }

  function encodeBase64Url(bytes) {
    return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  }

  function decodeBase64Url(value) {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid Base64URL value")
    const padding = "=".repeat((4 - (value.length % 4)) % 4)
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  }

  function normalizeServerUrl(value) {
    let url
    try {
      url = new URL(String(value).trim())
    } catch {
      throw new Error("Enter a valid server URL")
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("Server URL must use HTTP or HTTPS")
    }
    if (url.protocol === "http:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      throw new Error("Non-local servers must use HTTPS")
    }
    if (url.username || url.password) throw new Error("Server URL cannot contain credentials")
    if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
      throw new Error("Server URL must be an origin without a path")
    }
    return url.origin
  }

  function normalizeApiKey(value) {
    const apiKey = String(value || "").trim()
    if (apiKey && !/^dlt_v1_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}$/.test(apiKey)) {
      throw new Error("Enter a valid Dele.to API key")
    }
    return apiKey
  }

  function readSelectedText(pageDocument = globalThis.document, pageWindow = globalThis.window) {
    const activeElement = pageDocument?.activeElement
    const tagName = activeElement?.tagName?.toUpperCase()
    const inputTypes = new Set(["", "email", "search", "tel", "text", "url"])
    const isTextControl = tagName === "TEXTAREA" || (tagName === "INPUT" && inputTypes.has(activeElement.type || ""))
    if (isTextControl && Number.isInteger(activeElement.selectionStart) && Number.isInteger(activeElement.selectionEnd)) {
      const selected = activeElement.value.slice(activeElement.selectionStart, activeElement.selectionEnd)
      if (selected) return selected
    }
    return pageWindow?.getSelection?.()?.toString() || ""
  }

  function friendlyShareError(error, authMode) {
    if (error?.code === "expiry_limit") {
      return authMode === "api_key"
        ? "Your current plan supports expiration up to 24 hours. Choose a shorter duration or upgrade to Pro."
        : "Choose an expiration of 1 hour or less, or add an API key for longer durations."
    }
    if (error?.code === "view_limit") {
      return authMode === "api_key"
        ? "Your current plan supports up to 10 views per share. Choose fewer views or upgrade to Pro."
        : "Choose 1 view, or add an API key to unlock higher view limits."
    }
    return error instanceof Error ? error.message : error?.message || "Could not create share"
  }

  function createShareFragment(rootSecret, readCapability) {
    const prefix = "dlt_read_v1_"
    if (!readCapability.startsWith(prefix)) throw new Error("Server returned an invalid read capability")
    const rootBytes = decodeBase64Url(rootSecret)
    const readBytes = decodeBase64Url(readCapability.slice(prefix.length))
    if (rootBytes.length !== 32 || readBytes.length !== 32) {
      throw new Error("Server returned invalid share credentials")
    }
    const envelope = new Uint8Array(65)
    envelope[0] = 1
    envelope.set(rootBytes, 1)
    envelope.set(readBytes, 33)
    return encodeBase64Url(envelope)
  }

  async function createEncryptedShare(text, settings = DEFAULT_SETTINGS, dependencies = {}) {
    if (typeof text !== "string" || text.length === 0) throw new Error("Select text to share")
    const cryptoApi = dependencies.crypto || globalThis.crypto
    const fetchApi = dependencies.fetch || globalThis.fetch
    if (!cryptoApi?.subtle || typeof cryptoApi.getRandomValues !== "function") {
      throw new Error("Web Crypto is unavailable")
    }
    if (typeof fetchApi !== "function") throw new Error("Network access is unavailable")

    const serverUrl = normalizeServerUrl(settings.serverUrl || DEFAULT_SETTINGS.serverUrl)
    const apiKey = normalizeApiKey(settings.apiKey)
    const expiresIn = Number(settings.expiresIn ?? DEFAULT_SETTINGS.expiresIn)
    const maxViews = Number(settings.maxViews ?? DEFAULT_SETTINGS.maxViews)
    if (!Number.isInteger(expiresIn) || expiresIn < 60) throw new Error("Invalid expiration")
    if (!Number.isInteger(maxViews) || maxViews < 1) throw new Error("Invalid view limit")

    const rootBytes = cryptoApi.getRandomValues(new Uint8Array(32))
    const rootSecret = encodeBase64Url(rootBytes)
    const keyMaterial = await cryptoApi.subtle.importKey("raw", rootBytes, "HKDF", false, ["deriveKey"])
    const encryptionKey = await cryptoApi.subtle.deriveKey({
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("deleto:share:v1"),
      info: new TextEncoder().encode("encryption"),
    }, keyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt"])
    const iv = cryptoApi.getRandomValues(new Uint8Array(12))
    const ciphertext = await cryptoApi.subtle.encrypt({ name: "AES-GCM", iv }, encryptionKey, new TextEncoder().encode(text))
    const envelope = JSON.stringify({
      v: 1,
      encrypted: bytesToBase64(new Uint8Array(ciphertext)),
      iv: bytesToBase64(iv),
    })
    const payload = encodeBase64Url(new TextEncoder().encode(envelope))
    if (!apiKey && payload.length > 16 * 1024) throw new Error("Selected text is too large for an anonymous share")
    const idempotencyKey = cryptoApi.randomUUID()
    const response = await fetchApi(`${serverUrl}/api/v1/shares`, {
      method: "POST",
      headers: {
        "Content-Type": "application/vnd.deleto.opaque+json;v=1",
        "Idempotency-Key": idempotencyKey,
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ payload, expires_in: expiresIn, max_views: maxViews }),
    })
    let result
    try {
      result = await response.json()
    } catch {
      result = null
    }
    if (!response.ok) {
      const error = new Error(result?.title || `Share creation failed (${response.status})`)
      const retryAfter = Number(response.headers?.get("Retry-After"))
      error.code = result?.code
      error.status = response.status
      error.retryAfter = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined
      error.authMode = apiKey ? "api_key" : "anonymous"
      throw error
    }
    if (!result || typeof result.id !== "string" || typeof result.read_capability !== "string") {
      throw new Error("Server returned an invalid share response")
    }

    const shareUrl = new URL(result.share_url || `/view/${encodeURIComponent(result.id)}`, `${serverUrl}/`)
    if (shareUrl.origin !== serverUrl) throw new Error("Server returned a share URL for another origin")
    shareUrl.hash = createShareFragment(rootSecret, result.read_capability)
    return {
      id: result.id,
      url: shareUrl.toString(),
      expiresAt: result.expires_at,
      deleteCapability: result.delete_capability,
      authMode: apiKey ? "api_key" : "anonymous",
    }
  }

  return {
    DEFAULT_SETTINGS,
    createEncryptedShare,
    createShareFragment,
    friendlyShareError,
    normalizeApiKey,
    normalizeServerUrl,
    readSelectedText,
  }
})
