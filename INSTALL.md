# Scape Local: install, rebuild and recovery

Scape Local is an offline replacement for Fractal's Adjust Pro configurator for the **Fractal
Scape** headset: EQ slots, lighting (themes and custom patterns), sidetone, mic noise cancellation, **Boost** and **Mic Boost**.
It runs from the system tray, starts with Windows, and needs no internet or account.

Everything needed to reinstall it, even if Fractal's site, SourceForge or npm disappear, is in the
**release kit** (`dist/Scape-Local-Kit-<version>/`). Keep a copy of that folder somewhere safe
(NAS, USB stick, cloud drive).

| Kit file | What |
|---|---|
| `Scape-Local-Setup-<ver>.exe` | The app installer. It also contains Equalizer APO 1.4.2 and offers to install it |
| `EqualizerAPO-x64-1.4.2.exe` | Standalone Equalizer APO installer (official, MD5-verified) |
| `EqualizerAPO-src-1.4.2.zip` | Equalizer APO GPL source (redistribution requirement) |
| `scape-adjust-source.zip` | This whole repo: app source, tests, protocol docs |
| `SHA256SUMS.txt` | Checksums of the above |

---

## 1. Install (new PC or after a reset)

1. Run **`Scape-Local-Setup-<ver>.exe`**. It isn't code-signed, so Windows SmartScreen may say
   "Windows protected your PC". Click **More info → Run anyway**. It installs per-user (no admin)
   to `%LOCALAPPDATA%\Programs\Scape Local`.
2. If Equalizer APO isn't installed, the setup asks whether to install the bundled copy. Say **Yes** if
   you want **PC Boost**:
   - Approve the UAC prompt and click through the APO installer.
   - In the **Configurator** (APO 1.4 calls it *Device Selector*), tick **only**
     `Headset Earphone (Fractal Scape Dongle)`. If you use the headset over USB-C, also tick its
     playback device when it appears.
   - For **Mic Boost**, also open the *Capture devices* tab and tick
     `Headset Microphone (Fractal Scape Dongle)`.
   - Restart Windows.
3. Scape Local starts at the end of setup and from then on **with Windows, hidden in the tray**
   (headphone icon). Click the icon to open it; closing the window hides it again. Quit from the tray menu.
4. Plug in the dongle or USB-C cable. The app connects by itself and reads the headset.
   **Nothing is written until you confirm the exact bytes.**

**Updating:** run a newer `Scape-Local-Setup-<ver>.exe` over the old one. Settings, presets and slot
backups are kept, and so is Start with Windows.

Uninstall from *Settings → Apps → Scape Local*. That removes the autostart entry and switches off
PC Boost if it was on. Equalizer APO is a separate program with its own uninstaller.

## 2. Equalizer APO notes (PC Boost)

- Boost writes `C:\Program Files\EqualizerAPO\config\scape-local-boost.txt` (a `Device:` line for
  the Scape + `Preamp: X dB`) and adds a marked `Include:` block at the end of `config.txt`.
  Turning Boost off removes both. Other APO/Peace settings aren't touched.
- **Other APO settings that apply to all devices also hit the Scape.** This is common with an old
  Peace preset ("Device: all"). The Boost panel detects this and warns. Fix it by limiting that
  preset to your other speakers in Peace, or by commenting out its `Include:` line in `config.txt`
  (keep a copy of the original file).
- If Boost seems to do nothing: open APO's **Editor**. With Boost on, `scape-local-boost.txt` should
  be listed and the Scape shown as affected. Re-run the Device Selector if Windows created a new
  audio endpoint (e.g. after a driver update).
- Boost raises the digital level, so very loud content can clip. Use the lowest level that works.

## 3. Rebuild from source

Needs Node.js 20+ and internet for the first `npm install` (Electron and electron-builder).

```powershell
# unzip scape-adjust-source.zip (or clone the repo), then:
cd scape-adjust\app
npm install
npm test                      # 48 tests: EQ codes, filter math, protocol allowlist, Boost on/off
npm start                     # run without installing
```

**Build the installer kit.** First put the two Equalizer APO files from an old kit (or from
<https://sourceforge.net/projects/equalizerapo/files/1.4.2/>, then check their MD5s against
`vendor/equalizer-apo-1.4.2/SOURCE.md`) into `vendor/equalizer-apo-1.4.2/`. Then:

```powershell
cd scape-adjust\app
npm run dist                  # tests -> electron-builder (NSIS) -> tools/make-kit.mjs
# output: scape-adjust\dist\Scape-Local-Kit-<version>\   (build files: dist\build-<version>\)
```

Bump `"version"` in `app/package.json` for each new kit. Commit first, because
`scape-adjust-source.zip` is made from the last commit.

Pinned tool versions: Electron **44.10.2**, electron-builder **26.18.0**, Equalizer APO **1.4.2**.

## 4. If even the kit is gone

- The **protocol** is fully documented in `PROTOCOL.md`. The app code in `app/renderer/js/` is plain
  ES modules with no framework.
- **Your own snapshot of Adjust Pro** (not in the public repo, because it's Fractal's copyrighted
  code): [`archive/README.md`](archive/README.md) explains how to save one into `archive/original/`.
  Then run `node tools/serve.js archive/original 8740` and open <http://localhost:8740> in Chrome/Edge.
- The renderer also runs in Chrome/Edge without Electron: `node tools/serve.js app/renderer 8741`.
  You get the EQ tools plus WebHID connect, but no tray or PC Boost.

## 5. Safety rules built into the app

- An allowlist of HID commands. **Firmware update, reboot and factory reset can't be sent.**
- Every headset write shows the exact bytes first. EQ slots are backed up before a write and read
  back afterwards.
- All network requests from the app are blocked.
