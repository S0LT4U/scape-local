# Adjust Pro archive

> **The archived files are not in the public repository.** They're Fractal Design's copyrighted
> code and assets. This README documents how a private snapshot was made, so you can save your own
> copy for personal use (e.g. into `archive/original/`, which is git-ignored).

Snapshot of Fractal Design's **Adjust Pro** web configurator, taken so the
Scape headset can still be configured if the site goes offline.

- **Captured:** 2026-11-21 (≈15:25 UTC)
- **Source:** https://adjust.fractal-design.com/
- **index.html Last-Modified:** Mon, 16 Nov 2026 12:17:56 GMT (served from S3 via CloudFront)
- **Build:** webpack, React + Redux. A single main bundle; no lazy chunks.

## Layout

| Path | What |
|---|---|
| `original/index.html` | Page shell (`<base href="/">`) |
| `original/runtime.83b14dab0b804d4f.js` | webpack runtime |
| `original/main.893cac2bcbcde67a.js` | The whole app (6.3 MB), including the HID protocol code |
| `original/main.bd8d6f106b365f9f.css` | Global CSS (CentraNo2 fonts, slick carousel) |
| `original/service-worker.js`, `workbox-1ab968a5.js` | Workbox precache SW. Its precache list was used to find every static file |
| `original/*.png / *.jpg / *.svg / *.woff …` | Images, icons, fonts (hashed filenames, as served) |
| `original/assets/` | Unhashed icons/images, `audio/noise.mp3` (used by the audio test) |
| `original/devices/{headset,dongle,hub}/firmware.json` | Firmware **manifests only** (see below) |
| `pretty/main.js`, `pretty/runtime.js`, `pretty/main.css` | Prettier 3.3.3 output (`--print-width 120`), used for analysis |

## URLs fetched

All relative to `https://adjust.fractal-design.com/`:

- `/` (index.html), `runtime.*.js`, `main.*.js`, `main.*.css`
- Every `url:` entry in `service-worker.js` precache (110 files) plus `workbox-1ab968a5.js`
- Every `n.p+"…"` asset reference in `main.*.js` and every `url(...)` in the CSS
- `devices/headset/firmware.json`, `devices/dongle/firmware.json`, `devices/hub/firmware.json`

There's no `manifest.json` or `robots.txt` on the server. Those paths return the SPA fallback page, so they weren't kept.

## Firmware: not archived on purpose

The manifests point to `devices/headset/headset_latest.bin` (rev 03.37.00,
VID 0x36BC PID 0x2001), `devices/dongle/dongle_latest.bin` (rev 03.21.00,
PID 0x0001) and two hub `.signed.bin` images. **The binaries weren't
downloaded.** Firmware flashing is out of scope for the local replacement
(see `../PROTOCOL.md`, DO NOT IMPLEMENT).

## External requests the original app makes at runtime

- `https://www.google-analytics.com/mp/collect` (GA4 Measurement Protocol; `pretty/main.js` ≈ line 17929)
- `devices/*/firmware.json` and the `.bin` files (same origin) when it checks for or runs updates
- Links (not fetches) to support.fractal-design.com, fractal-design.com manuals, and a Windows portable build
  `software.fractal-design.com/1.0.12/fractal-portable-1.0.12-win-x64.zip`

## Running the archive locally

```
node tools/serve.js archive/original 8740
```

Then open http://localhost:8740 in Chrome or Edge. localhost is a secure context, so WebHID works.

Tested on 2026-11-21 in Chromium: the UI loads, the service worker registers,
fonts and backgrounds load, and `navigator.hid` is available. Routes such as
`/Audio` redirect to `/Devices` until a device is paired. That's normal app
behaviour. Pairing with real hardware still needs testing by the owner.
