# Scape Local

Offline tray app for the Fractal Scape headset: EQ slots, lighting on/off, sidetone and
mic noise cancellation. It replaces Fractal's Adjust Pro web app. No account, no telemetry,
and no network access: every non-local request is blocked in the Electron session.

## Run

```powershell
cd scape-adjust\app
npm install        # once (Electron 44.10.2)
.\start-scape.cmd  # or: npm start
```

- On first launch it registers **Start with Windows**, launching hidden in the system tray.
  You can toggle this in the tray menu or in the app. The login item runs
  `node_modules\electron\dist\electron.exe "<this folder>" --hidden`, so keep the folder where it is.
- Closing the window hides it to the tray. Quit from the tray menu.
- The headset (USB-C) or 2.4 GHz dongle connects automatically. The app **reads everything first**.
- The page also works in Chrome/Edge without the headset (EQ code tools, graph, presets):
  `node ..\tools\serve.js renderer 8741` → http://localhost:8741

## Safety

- Every packet passes an **allowlist** (`renderer/js/protocol.js`). Firmware, reboot and
  factory-reset commands can't be sent. See `../PROTOCOL.md` §9.
- Every write shows the exact bytes in a confirm dialog first.
- Before an EQ slot is saved, its current contents are backed up (Slot backups list).
  After the write the slot is read back and compared.
- "Re-apply on every connect" (lighting off, sidetone 0, noise cancellation off) is off until you
  enable it. When on, it only sends what differs from the headset's current state.

## Boost (louder mode)

One toggle plus a slider from +1 to +14 dB (112–501 %). PC mode follows the slider live; headset mode applies when you release it (each change is a confirmed write) and stops at +12 dB.
A "BOOST +X dB" badge shows in the header and tray tooltip while it's on. A hearing-safety
note appears the first time you turn it on.

- **PC (default, Windows only):** writes `scape-local-boost.txt` (a `Device:` line for the Scape's
  playback endpoint plus `Preamp: X dB`) into Equalizer APO's config folder, and adds one managed
  `Include:` block at the end of `config.txt`. Turning it off removes the block (config.txt restored
  byte for byte) and deletes the file. Peace's files are never touched.
  - **Requires Equalizer APO installed and attached to the Scape** ("Headset Earphone (Fractal
    Scape Dongle)") via its Configurator, plus a reboot. The panel shows these steps until it's detected.
  - ⚠ Other APO config that applies to *all* devices (often an old Peace preset) hits the Scape too.
    The panel detects and warns about it. Limit that preset to your other speakers first.
- **Headset EQ:** adds a high shelf at 20 Hz (+X dB, Q 0.707) as an extra band in the active slot.
  Works with any source, but only up to +12 dB and only for presets with ≤ 4 bands (not Competitive).
  The slot is backed up first; turning Boost off writes the exact original back and checks the read-back.

## Tests

```powershell
npm test
```
