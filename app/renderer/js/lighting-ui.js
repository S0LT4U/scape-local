// Lighting card (home view): Fractal themes, custom patterns, brightness, live LED preview, upload.
import { THEMES, PATTERNS, MODE, LED_COUNT, FPS, renderEffect, patternFor, rgbToHex } from './lighting.js';

const DEFAULT_COLORS = ['#0074C5', '#6E00FA', '#00FAEB', '#C940BD', '#95FDE4', '#00F03C'];

/**
 * ctx: { $, el, state, store, toast, guarded, canWrite(), afterWrite(device) }
 */
export function initLighting(ctx) {
  const { $, el, state, store, toast } = ctx;
  const saved = store.get('scape.lighting', {});
  const ui = {
    tab: saved.tab === 'custom' ? 'custom' : 'themes',
    themeId: THEMES.some((t) => t.id === saved.themeId) ? saved.themeId : THEMES[0].id,
    mode: patternFor(saved.mode) ? saved.mode : MODE.BREATHE,
    colors: Array.isArray(saved.colors) && saved.colors.length === 6 ? saved.colors : DEFAULT_COLORS.slice(),
    speed: saved.speed >= 1 && saved.speed <= 100 ? saved.speed : 50,
    brightness: saved.brightness >= 0 && saved.brightness <= 100 ? saved.brightness : 100,
    uploading: false,
  };
  const save = () => store.set('scape.lighting', { tab: ui.tab, themeId: ui.themeId, mode: ui.mode, colors: ui.colors, speed: ui.speed, brightness: ui.brightness });

  /** The effect currently selected in the card. */
  function currentSpec() {
    if (ui.tab === 'themes') {
      const t = THEMES.find((x) => x.id === ui.themeId);
      return { ...t, presetId: t.id, brightness: ui.brightness };
    }
    const p = patternFor(ui.mode);
    return { mode: ui.mode, colors: ui.colors.slice(0, p.colors), speed: ui.speed, brightness: ui.brightness };
  }
  const describe = (spec) =>
    spec.presetId != null && THEMES.some((t) => t.id === spec.presetId)
      ? THEMES.find((t) => t.id === spec.presetId).name
      : `Custom · ${patternFor(spec.mode)?.name ?? 'pattern ' + spec.mode}`;

  // ---- LED preview (plays the exact frames that would be uploaded) ----
  const leds = Array.from({ length: LED_COUNT }, () => el('span', { class: 'led' }));
  $('ledPreview').replaceChildren(...leds);
  let frames = null;
  let frame = 0;
  function preview() {
    try {
      frames = renderEffect(currentSpec()).frames;
      frame = 0;
      $('lightPreviewing').textContent = `Preview: ${describe(currentSpec())}`;
    } catch (err) {
      frames = null;
      $('lightPreviewing').textContent = err.message;
    }
  }
  setInterval(() => {
    if (!frames || document.hidden || document.body.dataset.view !== 'lighting') return;
    const n = frames.length / (3 * LED_COUNT);
    const o = (frame % n) * 3 * LED_COUNT;
    for (let i = 0; i < LED_COUNT; i++) leds[i].style.backgroundColor = rgbToHex(Array.from(frames.subarray(o + 3 * i, o + 3 * i + 3)));
    frame++;
  }, 1000 / FPS);

  // ---- themes ----
  const themeButtons = THEMES.map((t) => {
    const sw = el('span', { class: 'swatch' });
    sw.style.background = `linear-gradient(90deg, ${t.colors.join(', ')})`;
    const b = el('button', { class: 'theme', type: 'button', 'data-theme': t.id }, sw, el('span', {}, t.name));
    b.addEventListener('click', () => {
      ui.themeId = t.id;
      ui.tab = 'themes';
      save();
      render();
      preview();
      apply(); // one click applies (no confirmation prompt)
    });
    return b;
  });
  $('lightThemes').replaceChildren(...themeButtons);

  // ---- custom ----
  $('selPattern').replaceChildren(...PATTERNS.map((p) => el('option', { value: p.mode }, p.name)));
  $('selPattern').addEventListener('change', (e) => {
    ui.mode = Number(e.target.value);
    save();
    render();
    preview();
  });
  function renderColors() {
    const p = patternFor(ui.mode);
    const inputs = ui.colors.slice(0, p.colors).map((c, i) => {
      const inp = el('input', { type: 'color', value: c.toLowerCase(), 'aria-label': `Colour ${i + 1}` });
      inp.addEventListener('input', () => {
        ui.colors[i] = inp.value.toUpperCase();
        save();
        preview();
      });
      return inp;
    });
    $('lightColors').replaceChildren(...inputs);
  }
  $('rngSpeed').addEventListener('input', (e) => {
    ui.speed = Number(e.target.value);
    $('speedValue').textContent = String(ui.speed);
    save();
    preview();
  });
  $('rngBrightness').addEventListener('input', (e) => {
    ui.brightness = Number(e.target.value);
    $('brightnessValue').textContent = `${ui.brightness}%`;
    save();
    preview();
  });
  document.querySelectorAll('input[name=lightTab]').forEach((r) =>
    r.addEventListener('change', () => {
      ui.tab = r.value;
      save();
      render();
      preview();
    }),
  );
  $('btnLightApply').addEventListener('click', () => apply());

  // ---- upload ----
  async function apply() {
    if (!ctx.canWrite() || ui.uploading) return;
    const spec = currentSpec();
    const bar = $('lightProgress');
    await ctx.guarded(async (d) => {
      ui.uploading = true;
      bar.value = 0;
      bar.classList.remove('hidden');
      render();
      try {
        const n = await d.writeLighting(spec, { onProgress: (i, total) => (bar.value = i / total) });
        state.light = await d.readLighting().catch(() => null);
        await ctx.afterWrite(d);
        toast(`Lighting set: ${describe(spec)} (${n} packets)`);
      } finally {
        ui.uploading = false;
        bar.classList.add('hidden');
      }
    });
    render();
  }

  // ---- render ----
  function render() {
    const hs = state.hs;
    const custom = ui.tab === 'custom';
    document.querySelectorAll('input[name=lightTab]').forEach((r) => (r.checked = r.value === ui.tab));
    $('lightThemes').classList.toggle('hidden', custom);
    $('lightCustom').classList.toggle('hidden', !custom);
    for (const b of themeButtons) {
      const sel = Number(b.dataset.theme) === ui.themeId;
      b.classList.toggle('is-selected', sel);
      b.setAttribute('aria-pressed', String(sel));
    }
    $('selPattern').value = String(ui.mode);
    renderColors();
    const p = patternFor(ui.mode);
    $('fldSpeed').classList.toggle('hidden', !p.speed);
    $('rngSpeed').value = String(ui.speed);
    $('speedValue').textContent = String(ui.speed);
    $('rngBrightness').value = String(ui.brightness);
    $('brightnessValue').textContent = `${ui.brightness}%`;

    // what the headset reports
    const l = state.light;
    let now = '—';
    if (hs) {
      if (!hs.lightsOn) now = 'Off';
      else if (l && !l.unknown) now = l.theme ? l.theme : `Custom · ${patternFor(l.mode)?.name}`;
      else if (l && l.unknown) now = `On (pattern ${l.mode}, not supported here)`;
      else now = 'On';
    }
    $('lightNow').textContent = now;
    const can = ctx.canWrite();
    $('btnLightApply').disabled = !can || ui.uploading;
    $('btnLightApply').textContent = ui.uploading ? 'Uploading…' : 'Apply to headset';
    $('lightHint').textContent = !state.device
      ? 'Connect the headset to apply. The preview works offline.'
      : ui.tab === 'themes'
        ? 'Click a theme to apply it. Brightness changes are applied with the button.'
        : state.enforce
          ? 'Note: "Re-apply on every connect" turns lighting off each time the headset connects.'
          : '';
    $('lightWdl').textContent = hs
      ? `Windows Dynamic Lighting: ${hs.wdlOptIn ? (hs.wdlActive ? 'on and controlling the LEDs (Windows may override these colours)' : 'enabled') : 'off'}. Shown read-only; change it in Adjust Pro.`
      : '';
  }

  render();
  preview();
  return { render, preview };
}

