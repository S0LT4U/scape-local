// WebHID transport for the Scape headset / dongle. One request in flight at a time.
import { HID_FILTERS, REPORT_ID, USAGE_PAGE, USAGE, PID_DONGLE, VID, checkPacket, replyMatches, hex, cmd, parse } from './protocol.js';
import { buildEffectUpload, readEffectMeta, parseEffectMeta } from './lighting.js';

const TIMEOUT_MS = 2000;

function isVendorInterface(d) {
  return d.collections.some(
    (c) => c.usagePage === USAGE_PAGE && c.usage === USAGE && (c.outputReports || []).some((r) => r.reportId === REPORT_ID),
  );
}

export class ScapeDevice extends EventTarget {
  constructor(hidDevice) {
    super();
    this.dev = hidDevice;
    this.isDongle = hidDevice.productId === PID_DONGLE;
    this.queue = Promise.resolve();
    this.log = [];
    this.writeHook = null; // async (packets, label) => boolean ; set by UI for confirmation
  }

  static supported() {
    return typeof navigator !== 'undefined' && 'hid' in navigator;
  }

  /** Already-permitted devices (Electron grants these automatically). */
  static async findPermitted() {
    const devs = await navigator.hid.getDevices();
    return pick(devs);
  }

  static async request() {
    const devs = await navigator.hid.requestDevice({ filters: HID_FILTERS });
    return pick(devs);
  }

  get name() {
    return this.isDongle ? 'Scape (2.4 GHz dongle)' : 'Scape headset (USB)';
  }

  async open() {
    if (!this.dev.opened) await this.dev.open();
  }

  async close() {
    try {
      if (this.dev.opened) await this.dev.close();
    } catch {}
  }

  _record(dir, bytes, note = '') {
    const entry = { t: new Date().toISOString().slice(11, 23), dir, hex: hex(bytes), note };
    this.log.push(entry);
    if (this.log.length > 500) this.log.shift();
    this.dispatchEvent(new CustomEvent('log', { detail: entry }));
  }

  /** Send one packet (must pass the allowlist). Resolves with the reply bytes, or true if no reply expected. */
  send(bytes) {
    const run = async () => {
      const info = checkPacket(bytes);
      let wait;
      if (info.reply) {
        wait = new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            this.dev.removeEventListener('inputreport', onReport);
            reject(new Error(`Timeout waiting for reply to ${info.name}`));
          }, TIMEOUT_MS);
          const onReport = (e) => {
            if (e.reportId !== REPORT_ID) return;
            const r = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
            if (r[0] !== bytes[0] || r[1] !== bytes[1]) return; // unrelated report (e.g. button event)
            clearTimeout(timer);
            this.dev.removeEventListener('inputreport', onReport);
            resolve(new Uint8Array(r));
          };
          this.dev.addEventListener('inputreport', onReport);
        });
      }
      this._record('→', bytes, info.name);
      await this.dev.sendReport(REPORT_ID, bytes);
      if (!wait) return true;
      const reply = await wait;
      this._record('←', reply.slice(0, 24), info.name);
      if (!replyMatches(bytes, reply)) throw new Error(`${info.name} failed (status ${reply[2]})`);
      return reply;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  /** Send a group of write packets, after the confirmation hook approves them. */
  /** Send write packets. With {confirm: true} the UI's confirmation hook must approve them first. */
  async write(packets, label, { confirm = false } = {}) {
    for (const p of packets) checkPacket(p); // validate everything before sending/asking
    if (confirm && this.writeHook && !(await this.writeHook(packets, label))) return { cancelled: true };
    const replies = [];
    for (const p of packets) replies.push(await this.send(p));
    return { cancelled: false, replies };
  }

  // ---- high-level reads -------------------------------------------------
  async readInfo() {
    const info = { connection: this.name };
    if (this.isDongle) {
      info.dongleFw = parse.fwVersion(await this.send(cmd.fwVersion(true)));
      const st = parse.dongleState(await this.send(cmd.deviceState(true)));
      info.headsetLinked = st.headsetLinked;
      if (!st.headsetLinked) return info;
    }
    info.firmware = parse.fwVersion(await this.send(cmd.fwVersion()));
    info.serial = parse.serial(await this.send(cmd.serial()));
    info.edition = parse.edition(await this.send(cmd.edition()));
    return info;
  }

  async readState() {
    return parse.deviceState(await this.send(cmd.deviceState()));
  }

  /** What the headset says is stored in lighting effect slot 1 (preset id, pattern, colours, …), or null. */
  async readLighting() {
    return parseEffectMeta(await this.send(readEffectMeta()));
  }

  /** Upload a lighting effect to effect slot 1 and select it. onProgress(sent, total) is called per packet. */
  async writeLighting(spec, { onProgress } = {}) {
    const { packets } = buildEffectUpload(spec);
    for (const p of packets) checkPacket(p);
    for (let i = 0; i < packets.length; i++) {
      await this.send(packets[i]);
      onProgress?.(i + 1, packets.length);
    }
    return packets.length;
  }

  async readSlot(slot) {
    let data = parse.eqData(await this.send(cmd.eqData(slot)));
    let factory = false;
    if (slot !== 1 && data.empty) {
      // Same as Adjust Pro: an empty slot 2/3 falls back to the factory preset stored at slot+2.
      data = parse.eqData(await this.send(cmd.eqData(slot + 2)));
      factory = true;
    }
    const name = factory ? '(factory default)' : parse.eqMeta(await this.send(cmd.eqMeta(slot)));
    return { slot, name, factory, bands: data.bands };
  }

  async readAll() {
    const info = await this.readInfo();
    if (this.isDongle && !info.headsetLinked) return { info, state: null, slots: [] };
    const state = await this.readState();
    const slots = [];
    for (const s of [1, 2, 3]) slots.push(await this.readSlot(s));
    return { info, state, slots };
  }
}

function pick(devs) {
  const ours = devs.filter((d) => d.vendorId === VID && isVendorInterface(d));
  // Prefer a direct USB headset over the dongle.
  ours.sort((a, b) => (a.productId === PID_DONGLE) - (b.productId === PID_DONGLE));
  return ours[0] ? new ScapeDevice(ours[0]) : null;
}
