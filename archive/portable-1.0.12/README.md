# Adjust Pro Portable 1.0.12 (Windows, Electron): reference files only

> **The extracted files are not in the public repository** (Fractal Design's copyrighted code).
> Only this description is published.

- **Source:** `fractal-portable-1.0.12-win-x64.zip` (122,343,723 bytes), which the owner downloaded from
  https://software.fractal-design.com/1.0.12/fractal-portable-1.0.12-win-x64.zip
- **SHA-256:** `1e60e986a765f4f215ca88b24ca088a565feeb580d9e66fcc8f0f8449ac83ebb`
- **Compared:** 2026-11-21. The zip was unpacked and `resources/app.asar` extracted with `@electron/asar`. Nothing was executed.

## What's kept here
Only the app's own small files: `index.js`, `package.json`, `portable/main.js` (Electron main
process with a bundled copy of `@fractal/hal`), `main.preload.js`, `web/index.html`,
`3rdpartylicenses.txt`, and `app-update.yml`. `pretty/main.js` is the Prettier output.
The Electron/Chromium runtime and DLLs weren't kept (re-download the zip if needed).

## Compared with the web archive (`../original`)
- `web/main.893cac2bcbcde67a.js`, `runtime.*.js`, `main.*.css`, `service-worker.js` and every
  image/font are **byte-identical** to the website snapshot. Same UI build.
- `index.html` differs only in `<base href="./">` (file:// loading) and the meta description.
- The portable build has **no** `devices/*/firmware.json`. Firmware checks fetch relative
  to file://, so they find nothing offline.
- Electron main (`portable/main.js`):
  - loads `web/index.html` over `file://`, sandboxed, with the menu removed
  - handles `select-hid-device` itself (its own device picker, via preload IPC) and grants HID
    permission only to `file://` and only for the Fractal VID/PID list
  - `app-update.yml` points at `https://d2o555x8v2et4b.cloudfront.net/portable` (Squirrel/electron-updater)
  - contains the HAL with **readable constant names** (FRACTAL_VENDOR_ID = 14012 = 0x36BC,
    HEADSET_PRODUCT_ID = 8193 = 0x2001, DONGLE_PRODUCT_ID = 1, HUB 4098, RADIUS 4099, dev PIDs, etc.)
    and method names such as SetEqSettings / SetEqCoef / SetEqSlot / CommitEq / sideToneControl.
    This is the main reference for PROTOCOL.md.
