# Scape Local

**An offline, open-source configurator for the Fractal Design Scape headset.** It does what
Fractal's *Adjust Pro* web app does for daily use (EQ slots, lighting, sidetone, mic noise
cancellation) and adds a system-wide **Boost** for when max volume isn't loud enough. It runs
from the Windows system tray, starts with Windows, and never touches the internet.

> Not affiliated with or endorsed by Fractal Design. "Fractal Design", "Scape" and "Adjust Pro"
> are trademarks of Fractal Design. Use at your own risk; see [Safety](#safety).

![Home view](docs/screenshot-home.png)

## Why

Adjust Pro is a website (adjust.fractal-design.com) that talks to the headset over WebHID. If
that site changes or goes away, the headset's EQ and settings become hard to manage. Scape Local
re-implements the parts you need locally, after mapping the headset's HID protocol (see
[PROTOCOL.md](PROTOCOL.md)).

## Features

- **EQ slots:** see the headset's three EQ slots by name and switch between them with one click.
- **EQ editor:** up to 5 bands (peak, low/high shelf, low/high pass, notch, band pass), live
  frequency-response graph, Adjust Pro-compatible **EQ share codes** (paste/copy), presets with
  JSON import/export. It writes to the headset with automatic backup and read-back verification.
- **Lighting** on/off, **sidetone** (0 to 100 %), **mic noise cancellation** on/off. Optional
  "my defaults" that are re-applied every time the headset connects.
- **Boost:** a slider from +1 to +14 dB (112 to 501 %), like a browser "amplify" extension but
  system-wide:
  - **PC mode** (Windows): a preamp scoped to the Scape's playback device through
    [Equalizer APO](https://sourceforge.net/projects/equalizerapo/). Works with every preset.
  - **Headset mode:** adds a +X dB high-shelf band to the active slot, so it also works on a
    console or another PC (up to +12 dB; needs a preset with 4 bands or fewer).
- **Tray app:** starts hidden with Windows, battery level in the tray tooltip, works over the
  2.4 GHz dongle or USB-C.
- **Offline and private:** no account, no telemetry. The app blocks all network requests.

![EQ editor](docs/screenshot-editor.png)

## Install

Download `Scape-Local-Setup-<version>.exe` from [Releases](../../releases) and run it.

- The installer is **not code-signed**, so Windows SmartScreen will warn. Click
  **More info → Run anyway**. You can check the download against `SHA256SUMS.txt` in the release.
- It installs per-user (no admin). For PC Boost it offers to install the bundled
  **Equalizer APO 1.4.2** (GPL; its source is attached to the release). In APO's Configurator,
  tick only the Scape's playback device ("Headset Earphone (Fractal Scape Dongle)"), then restart.

Full details, updating, uninstalling and rebuilding: [INSTALL.md](INSTALL.md).

## Safety

The app talks to the headset through a strict **allowlist** of HID commands
([`protocol.js`](app/renderer/js/protocol.js)):

- **Firmware update, bootloader/reboot and factory reset can't be sent.**
- Every packet's arguments are range-checked. EQ values are validated (20 Hz to 20 kHz, ±12 dB, Q 0.4 to 10).
- Before an EQ slot is overwritten, its contents are backed up. After writing, the slot is read
  back and compared. Overwriting a slot from the editor asks for confirmation.
- Every packet sent and received is shown in the **HID packet log** (EQ editor view).

Tested on a Scape over the 2.4 GHz dongle (dongle FW 03.21.00, headset FW 03.30.00). USB-C
direct mode uses the same commands but hasn't been tested yet.

**Hearing:** Boost can make audio a lot louder. Turn the volume down before enabling it. Very
loud content may clip (crackle) at high Boost levels.

## Roadmap / not yet supported

**Lighting customization is the main gap.** Today Scape Local can only turn the headset RGB
**on or off**. These Adjust Pro lighting features aren't implemented yet:

- **Fractal themes:** Northern lights, Summer sky, Sunset, Starfall, Glistening ice, Pink sapphire,
  Lunar mist, Mystic night, Campfire, Radiant dawn.
- **Custom lighting patterns:** Shift, Still, Breathe, Waves, Two color fade, Lava lamp, each with
  a colour palette.
- **Colour picker** (hex/RGB), **speed** and **brightness**.
- **Windows Dynamic Lighting (WDL)** enable/disable (Advanced settings).

The protocol for uploading lighting effects is already mapped (multi-packet effect upload,
[PROTOCOL.md §6](PROTOCOL.md#6-lighting-headset)). It hasn't been built yet because it writes
effect data to the headset's storage and needs careful testing first. Contributions and testers are welcome.

Other open items:
- USB-C direct mode is untested (should work; same commands).
- Mic EQ (documented in PROTOCOL.md §7, no UI yet).
- Whether settings survive a headset power cycle hasn't been confirmed. "Re-apply on every connect"
  covers the defaults either way.

## How it works

| Path | What |
|---|---|
| [`PROTOCOL.md`](PROTOCOL.md) | The headset's HID protocol: report layout, every command, EQ write sequence, what is blocked and why |
| [`app/renderer/js/`](app/renderer/js) | Plain ES modules: `protocol.js` (packets and allowlist), `hid.js` (WebHID), `eqcode.js` (share codes), `biquad.js` (RBJ filters), `boost.js`, `app.js` (UI) |
| [`app/main.cjs`](app/main.cjs), [`apo-host.cjs`](app/apo-host.cjs) | Electron shell: tray, autostart, HID permissions, network block, Equalizer APO config |
| [`app/tests/`](app/tests) | 48 Node tests: share codes (byte-exact), filter math, allowlist, Boost on/off round trips, APO config restore |

The UI also runs in Chrome or Edge without Electron (`node tools/serve.js app/renderer 8741`,
then open http://localhost:8741) for the EQ tools and WebHID access. There's no tray or PC Boost there.

## Build

```powershell
cd app
npm install
npm test
npm start          # run from source
npm run dist       # installer + release kit (needs the APO files in vendor/, see INSTALL.md)
```

Electron 44.10.2, electron-builder 26.18.0.

## License

[MIT](LICENSE) for this project. The bundled Equalizer APO installer is GPL-2.0 (© Jonas
Thedering); its unmodified source archive is published alongside each release.
