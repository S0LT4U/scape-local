# Fractal Scape: HID protocol (as used by Adjust Pro)

Derived by reading Adjust Pro's code. **Reads verified on hardware 2026-11-21** (Scape over the
2.4 GHz dongle; dongle FW 03.21.00, headset FW 03.30.00): firmware, serial, edition, device
state and all 3 EQ slots parsed as documented, and slot data decoded to exactly the
Everyday/Competitive/Immersive share codes.

**EQ write verified 2026-11-21:** slot 1 was re-saved with Everyday (`A7 01` + 9× `A7 02` + `A7 03 … mode 2`,
name "Everyday") over the dongle. Every packet got status `00`, and the read-back matched byte for byte.
The `COMMIT_EQ` reply carries extra bytes after the status
(`A7 03 00 03 00 00 00 01 00 21 00 03 00 90 6B 00 22 80 95 00 B4 73 69`, meaning unknown).
Lighting on/off writes have since been confirmed in use: the state read-back follows each change.
Sidetone and ENC writes are implemented exactly as documented here and are less tested. Still
unknown: whether settings survive a power cycle.

> **About the line references:** `P:` and `W:` refer to local, pretty-printed copies of Adjust Pro's
> JavaScript (the portable 1.0.12 build and the web build). Those files are Fractal Design's
> copyrighted code, so they're **not included in this repository**.
> [`archive/README.md`](archive/README.md) describes how to make your own snapshot. Everything below
> is a description in my own words of the observable protocol, for interoperability.

Sample `F1 21` reply from that test: `F1 21 00 01 01 01 00 00 00 00 00 00 00 01 45 01 00 00 01 00 01`
(no boom mic, not muted, EQ slot 1, lights off, battery 0x45 = 69 %, sidetone enabled with volume 0, ENC off).
The sources are the web bundle `archive/pretty/main.js` and the more readable copy of the
same device code in `archive/portable-1.0.12/pretty/main.js`. Line refs below point to the
portable copy (**P:**) or the web copy (**W:**).

Confidence tags: **[src]** is read directly from the code. **[inferred]** is reasoned from
the code but not stated in it. **[unknown]** needs a hardware test.

---

## 1. Devices and WebHID filters

| Device | VID | PID | Notes |
|---|---|---|---|
| Scape headset over USB-C | `0x36BC` (14012) | `0x2001` (8193) | [src] P:3785–3797 |
| Scape 2.4 GHz dongle | `0x36BC` | `0x0001` | Headset commands are tunnelled through it [src] |
| Adjust Pro Hub | `0x36BC` | `0x1002` (+`0x1001` dev) | not relevant |
| Radius AIO | `0x36BC` | `0x1003` | not relevant |
| Headset dev unit | `0x0E8D` (3725) | `0x080B` (2059) | MediaTek VID; factory/dev hardware |
| Dongle dev unit | `0x0E8D` | `0x080A` (2058) | |

The dock has no USB ID of its own. It only reports its "hall sensor" through device state.

`navigator.hid.requestDevice` filters [src] P:2068–2121, one per device:

```js
{ vendorId: 0x36BC, productId: 0x2001, usagePage: 0xFF00, usage: 0x01 }  // headset
{ vendorId: 0x36BC, productId: 0x0001, usagePage: 0xFF00, usage: 0x01 }  // dongle
```

After the picker, the app keeps the first `HIDDevice` whose collection has
`usagePage 0xFF00`, `usage 0x01` **and an output report with ID 2** (`isP911`, P:281–290).

## 2. Transport

- **Report ID 2**, sent as an **output report** (`device.sendReport(2, data)`). No feature reports are used. [src]
- `data[0]` = **device-type / command group**, `data[1]` = **command**, then the payload.
  Most packets are short. Chrome pads them to the report size.
- **Response:** for every command in the "expects reply" table (P:3815–3886), the app waits for the next
  `inputreport` (timeout **2000 ms**, firmware request 10 s). The reply passes validation when
  `resp[0] == data[0] && resp[1] == data[1] && resp[2] == 0x00` (status OK).
  The one exception is `GET_EQ_SETTINGS`, where byte 2 holds data. Replies are parsed as 63-byte buffers. [src] P:3887–3894
- Commands are serialised with a mutex. Only one is outstanding at a time. [src]
- **Dongle:** when the dongle is connected, the app opens it, asks for its state (`11 21`).
  If `resp[3] == 1` (headset linked), it runs the **same headset command set over the dongle's
  HIDDevice**. So headset commands look identical whether you're on USB or 2.4 GHz. [src] P:3159–3175

### Command groups (`data[0]`)

| Byte | Name | Used for |
|---|---|---|
| `0xF1` | DEVICE_TYPE_FACTORY_HEADSET | info, state, sidetone, ENC, **factory reset (forbidden)** |
| `0x11` | DEVICE_TYPE_FACTORY_DONGLE | dongle info/state |
| `0xA7` | DEVICE_TYPE_EQ | EQ slots, mic EQ, (sidetone constant lives here but is sent with 0xF1) |
| `0xA4` | DEVICE_TYPE_EFFECT | RGB lighting |
| `0xA5` | DEVICE_TYPE_STREAMING | live RGB stream (SignalRGB-style) |
| `0xB5` | DEVICE_TYPE_FW_UPGRADE_HEADSET | **firmware: DO NOT IMPLEMENT** |
| `0x15` | DEVICE_TYPE_FW_UPGRADE_DONGLE | **firmware: DO NOT IMPLEMENT** |
| `0xD1` | DEVICE_TYPE_PWM | hub fans (n/a) |

---

## 3. Read-only commands (safe)

All of these are `F1 xx` on the headset (`11 xx` for the dongle itself).

| Command | Bytes sent | Reply parsing [src] |
|---|---|---|
| Firmware version | `F1 01` | bytes 3–5, each byte shown as two decimal nibbles → `"03.37.00"` style (P:430–441) |
| Serial number | `F1 02` | ASCII starting at byte 6, up to 17 chars, NUL-terminated (P:2363–2374) |
| Edition ID | `F1 04` | byte 3 as hex (headset colour/edition) |
| Bluetooth address | `F1 05` | bytes 3–8 as hex |
| **Device state** | `F1 21` | see table below (P:2672–2711) |
| EQ slot data | `A7 04 <slot> 00` | see §5 |
| EQ slot metadata (name) | `A7 04 <slot> 01` | byte 3 = length, then UTF-8 name |
| EQ coefficients | `A7 05 <slot> <rate> <point>` | 5× f32 LE at offset 6: b0 b1 b2 a1 a2 |
| Mic EQ | `A7 13 <micType> <page>` | 8× f32 LE at offset 4 |
| Read effect / metadata | `A4 05 <slot> <offHi> <offLo>` | lighting effect bytes (metadata at offset 10, 42 bytes) |

### Device state reply (`F1 21`)

| Byte | Field | Meaning |
|---|---|---|
| 3 | hasBoomMic | **0 = boom mic connected** (inverted) |
| 4 | isMuted | **0 = muted** (inverted) |
| 5 | selectedEqSlot | active EQ slot, 1–3 |
| 6 | selectedSlot | **active lighting effect slot. 0 = lights off** |
| 7–8 | chatVol | (byte 8 is effectively unused) |
| 9–10 | gameVol | |
| 11 | volumeState | |
| 12 | btMode | |
| 13 | hallSensor | docked / undocked [inferred] |
| 14 | **battery** | percent |
| 15 | sidetoneState | 1 = enabled |
| 16 | sidetoneVol | raw volume (see §7) |
| 18 | btConnState | |
| 19 | **encState** | 1 = mic noise cancellation on |
| 20 | powerState | |
| 33 | dynamic-lighting flag | Windows Dynamic Lighting |
| 40 | WDL opt-in | |

The battery level, firmware version, active slots, ENC and sidetone are therefore all readable without writing anything.

---

## 4. Constants worth knowing

- **3 EQ slots** (IDs 1, 2, 3; `eqNumMax = 3`). [src] P:2601
- **Max 5 EQ bands per slot** (`MAX_EQ_POINTS = 5`), with no master-gain field in the band list. [src] P:2184
- **Filter types:** `0 Peak, 1 LowShelf, 2 HighShelf, 3 LowPass, 4 HighPass, 5 Notch, 6 BandPass`. [src] P:546–552
  → **type 2 = high shelf is confirmed.**
- **Sample-rate codes:** `1 = 44.1k, 2 = 48k, 4 = 96k`. Slot data uses mask `7`. [src]
  The app computes 44.1k coefficients with **fs = 44000** (not 44100), a quirk in Fractal's code (W:4404–4416).
  We copy it so our coefficients match what Adjust Pro writes.
- **Mic EQ gain clamp:** −20…+18 dB. **Lighting effect slots:** 0–3, where **0 = off**.
- **Headset LEDs:** 12 (sub-device 153, "Headset").

---

## 5. EQ: how a slot is written (the same 3-step sequence as Adjust Pro)

Adjust Pro calls `SetEqSettings → SetEqCoef → CommitEq` (W:8096–8105). **The headset does not
compute filters itself. The PC sends finished biquad coefficients for each sample rate.**

### 5.1 `SET_EQ_SETTINGS`: `A7 01 …` (63 bytes) [src] P:2730–2760

```
A7 01 ((slot << 4) | 0x7)                  // slot 1..3, rate mask 7 (all three rates)
then exactly 5 point records of 12 bytes:
  u8  enabled (1 = used, 0 = unused)
  u8  filter type (0..6)
  u16 freq Hz, LE
  f32 gain dB, LE
  f32 Q, LE
unused points = 00 00 20 00 | f32 0.0 | f32 0.5      (freq 32 Hz, disabled)
0-band (flat) slot: point 0 = 01 00 F0 55 | 0.0 | 0.5 (22000 Hz, enabled, 0 dB)
```

### 5.2 `SET_EQ_COEF`: one packet per band per sample rate (25 bytes) [src] P:2761–2791

```
A7 02 <slot> <rateCode 1|2|4> <pointIndex 0..4>  b0 b1 b2 a1 a2   (5x f32 LE, a0 normalised to 1)
```

Coefficients are standard **RBJ Audio-EQ-Cookbook** biquads (W:11560–11653), with
`A = 10^(gain/40)` and `alpha = sin(w0)/(2Q)`, then normalised by a0 and rounded with `Math.fround`.
For a flat slot, Adjust Pro sends three "identity" packets (point 0, rates 1/2/4) with
`b = [1, a1, a2]`, `a = [a1, a2]` taken from hard-coded tables (P:1945–1954).

### 5.3 `COMMIT_EQ`: `A7 03 …` [src] P:2792–2806

```
A7 03 <slot> <mode> 00 00 00 00 <len> <UTF-8 presetId…>
mode: 1 = LiveUpdate (audition, not saved), 2 = SaveEq (store to flash), 3 = EraseEq
```

The 4 zero bytes are an f32 that is always 0.0. It's probably a reserved/master-gain field
**[unknown]**. Adjust Pro never sends anything else there, so we must not either.

**Slot "name":** the device stores only the string `presetId`. Adjust Pro writes a preset id.
On the test headset these are **21-character nanoid strings** (e.g. `9K5NqQ5BJvsuem73wRsw-`),
and the built-in defaults use 36-char UUIDs. The friendly preset name lives in browser storage, not on the headset. We can store
a short readable name instead [inferred: any UTF-8 ≤ ~50 bytes fits in the 63-byte report].

### 5.4 Select active slot: `A7 07 <slot>` [src] P:2844–2849

### 5.5 Reading slots [src] P:2807–2843

`A7 04 <slot> 00` returns the same 5×12 point layout starting at byte 3 (byte 2 = `(id<<4)|rate`).
Records with `enabled == 0` or freq > 20000 are skipped. For slots 2 and 3, if `resp[3] == 0`
(slot empty), Adjust Pro reads **slot+2** (4 or 5) instead. Those look like the factory
default presets. Coefficients are then read back with `A7 05`.

### 5.6 Share code compared with the device format

The share code (W:70454–70530) is a different, compact layout. The two only share the field
*values*:

| | Share code | Device (`A7 01`) |
|---|---|---|
| per band | 15 B: type, f32 gain, f32 Q, **u16 freq**, 4×00 | 12 B: enabled, type, u16 freq, f32 gain, f32 Q |
| order | type, gain, Q, freq | enabled, type, freq, gain, Q |
| bands | N (1 byte) | always 5 records |
| check | XOR of all bytes before the last | none; the reply status byte is checked |
| coefficients | none (recomputed on paste) | sent separately with `A7 02` |

Your notes say u32 freq + 2 pad bytes. On the wire that's identical, because the code writes a
u16 at offset 9 and the next 4 bytes are zero.

---

## 6. Lighting (headset)

- **On/off:** `turnLight(on)` on the headset is just **select effect slot 1 or 0**:
  `A4 04 01` (on, slot 1) or **`A4 04 00` (lights off)**. [src] P:2855–2857, 2356–2362
- **Effect upload (frame-based, what Adjust Pro uses for the Scape):** [src] P:2213–2340
  1. `A4 01 01 <checksum> <lenLo> <lenHi>` SET_EFFECT. Slot 1, checksum = sum of all package bytes & 0xFF,
     length little-endian.
  2. `A4 02 <n> <n bytes, zero-padded to 60>` SEND_EFFECT, repeated until the package is sent (63-byte packets).
  3. `A4 03` COMMIT_EFFECT.
  4. `A4 04 01` SELECT_EFFECT_SLOT (this also turns the lights on).
  Every packet gets a reply with the usual echo + status 0.
- **Package:** `A5 5A <frameCount> FF <fps=20> <durationSeconds>` + 42 bytes of metadata (zero-padded) +
  frames. A frame is the **12 LEDs** x RGB = 36 bytes (the Scape is ARGB sub-device 153 with 12 LEDs, W:4618).
  duration = `11 − floor(clamp(speed,10,100)/10)` seconds. Frame count ≤ 255 (one byte).
- **Metadata** (what Adjust Pro reads back to show the current preset): `<presetId> <mode> <speed>
  <colours, unscaled RGB…> <brightness>`. Waves appends `up top down (100−freq) brightness <colour 2 scaled>`;
  Two colour fade is `… <c1> <c2> <speed> <brightness>`. Fractal theme preset ids: Northern lights 0,
  Summer sky 1, Sunset 2, Mystic night 3, Radiant dawn 5, Campfire 11, Glistening ice 12, Starfall 13,
  Pink sapphire 14, Lunar mist 15. Custom presets use ids from 64 up.
- **Patterns the Scape supports** (W:7108–7118): Shift (mode 0, 6 colours), Still (1, 1 colour), Breathe (2,
  2 colours), Lava lamp (6, 6 colours, random by design), Waves/"wave ripple" (7, 2 colours), Two colour fade
  (8, 2 colours). Frames are rendered on the PC; `app/renderer/js/lighting.js` reproduces Adjust Pro's
  renderers **byte for byte** (checked against the original code for all 10 themes and edge cases).
- **Brightness** isn't a separate command. The header's brightness byte is fixed at `0xFF`, and the colours
  are scaled (`round(c × brightness/100)`) before frames are rendered. The brightness value is stored in the
  metadata.
- **Read back:** `A4 05 01 00 00` (READ_EFFECT, slot 1, offset 0). Metadata starts at reply byte 10.
- **Windows Dynamic Lighting (WDL):** `F1 15 <0|1>` sets the opt-in switch; Adjust Pro expects **no reply**
  (P:3866), which suggests the headset re-enumerates (it then appears as a Windows LampArray). State bytes:
  40 = opt-in, 33 == 0 = Windows currently drives the LEDs. **Scape Local shows the status read-only and
  doesn't send `F1 15`.**
- **Not used / blocked:** `A4 01` with length 0 (clears the slot), slot 0 boot effects, the timestamp-based
  variant `A4 11/12/13` (Adjust Pro Hub only), `A4 78` stop-loading, `A5 …` RGB streaming (SignalRGB).

## 7. Mic: sidetone and noise cancellation

### Sidetone: `F1 34 <action> <steps>` [src] P:2885–2894, W:70985–71040

- `action`: `0 Disable, 1 Enable, 2 VolUp, 3 VolDown`. `steps`: number of volume units (the app
  sends at most 50 per packet and splits larger moves, W:8256–8262).
- Reply: byte 3 = state, byte 4 = raw volume `v`. The UI shows `v` through a lookup table:
  `0 → 0 %`, `55 → 10 %`, `60 → 20 %` … `100 → 100 %` (5 units per 10 %).
- Volume is **relative only**. There's no "set to N" command.
- ⚠ When the Audio page opens, Adjust Pro sends `F1 34 01 01` (Enable, 1) to read the state.
  That may also *enable* sidetone or bump it by one step **[unknown]**. We **won't** do that. We
  read sidetone from device state (bytes 15/16) instead.
- **Setting sidetone to 0:** send `F1 34 03 32` (VolDown 50), then read state. Repeat up to 3 times
  until volume = 0. Adjust Pro's own "reset" does exactly one `VolDown 50`. The app never sends
  `Disable`, so we won't rely on it either.

### Mic noise cancellation (ENC): `F1 36 <0|1>` [src] P:2850–2854, W:71258–71280

- `F1 36 00` = **ENC off**, `F1 36 01` = on. Read back from device state byte 19.

### Mic EQ (not required, documented for completeness)

`A7 11 <micType> <page> <8× f32>` sets, `A7 12 01 <micType>` saves, `A7 12 02 <micType>` erases,
`A7 13` reads. micType: 1 CupWB, 2 BoomWB, 3 CupSWB, 4 BoomSWB.

---

## 8. Your requested defaults (planned writes, all from §6–7)

| Setting | Packet(s) | How it's verified |
|---|---|---|
| Lighting off | `A4 04 00` | `F1 21` byte 6 == 0 |
| Sidetone 0 | `F1 34 03 32` (×≤3) | reply byte 4 == 0, and `F1 21` byte 16 == 0 |
| Mic NC off | `F1 36 00` | `F1 21` byte 19 == 0 |

**[unknown]** Whether these settings survive a power cycle is unknown. The plan is to re-apply
them on every connect (optional), only after reading state and only when a value differs. The
exact bytes will be shown for approval before the first write.

---

## 9. ⛔ DO NOT IMPLEMENT

The local app must never construct these. They'll be blocked in a single `send()` guard:

| Bytes | What it does |
|---|---|
| `B5 01 / 02 / 03`, `15 01 / 02 / 03` | Request / send / commit **firmware upgrade** (headset / dongle) |
| `B5 04`, `15 04` | **Reboot** (end of the OTA flow) |
| **`F1 F2`** (and dongle `11 F2`) | **Factory reset** |
| `F1 15`, `11 15` | Set Windows Dynamic Lighting opt-in switch (persistent config; not needed) |
| `A7 06` | `SWITCH_EQ_MODE`: defined but never used by Adjust Pro, so behaviour is unknown |
| `A4 0D / 0F / 09 / 17 / 19 / 15` | Sub-device rename/type/LED-count/rotation/mirror/legacy switches (hub features) |
| `A5 F0 / 01 / F1` | Live RGB streaming |
| `A7 12 02` | Mic EQ erase (low risk, but not needed) |

No calibration or bootloader commands exist beyond the firmware group above.

---

## 10. Notes for Phase 4 (Boost)

- **There's no device-side output gain, volume cap or "hearing protection" command** anywhere in the
  HAL. Volume bytes in device state are read-only.
- The 4-byte f32 in `COMMIT_EQ` is the only unexplained field. It's always 0 and could be a gain
  or reserved field **[unknown]**. Experimenting with it is a risk I'd avoid.
- An EQ-based boost is possible: high shelf (type 2) at 20 Hz, +X dB. But **the 5-band limit
  matters**. Everyday and Immersive use 3 bands, so there's room. **Competitive already uses 5,
  so boost can't be added on top** without merging it into an existing band.
