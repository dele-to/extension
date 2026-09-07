chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen" || message.type !== "copy") return false
  try {
    const textarea = document.createElement("textarea")
    textarea.value = message.text
    textarea.setAttribute("readonly", "")
    document.body.appendChild(textarea)
    textarea.select()
    const copied = document.execCommand("copy")
    textarea.remove()
    if (!copied) throw new Error("Clipboard write was rejected")
    sendResponse({ ok: true })
  } catch (error) {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : "Clipboard write failed" })
  }
  return false
})
