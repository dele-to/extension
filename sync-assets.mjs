import { copyFile } from "node:fs/promises"

await Promise.all([
  copyFile(new URL("../public/main-logo.png", import.meta.url), new URL("./main-logo.png", import.meta.url)),
  copyFile(new URL("../public/logo-text.png", import.meta.url), new URL("./logo-text.png", import.meta.url)),
])
