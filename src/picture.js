// -----------------------------------------------------------------------------
// The widget picture, drawn like the flux-solaire page: the diagram (panels,
// house, Urban Solar virtual battery, tracks and moving dashes) on the left,
// the four readings on the right, in a 16:9 frame (the frame the Gladys core
// gives an image), transparent so the card's own background shows through.
// Pure: flows in, SVG out. Text uses the bundled fonts (fonts/, OFL).
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';

export const SIZE = { width: 1280, height: 720 };

/** The palettes of the page (its CSS tokens), without the page background. */
export const THEMES = {
  dark: {
    surface: '#17212d',
    ink: '#e8eef5',
    muted: '#9aa8b8',
    line: '#2a3747',
    sun: '#f2b544',
    home: '#3cc4aa',
    store: '#9b84f0',
    grid: '#6f7c8c',
    track: '#243142',
  },
  light: {
    surface: '#ffffff',
    ink: '#172230',
    muted: '#5b6878',
    line: '#d5dde6',
    sun: '#d98a12',
    home: '#1f8a78',
    store: '#6a4fc9',
    grid: '#8a96a5',
    track: '#dfe5ec',
  },
};

const FONT = {
  display: "'Bricolage Grotesque 36pt', 'IBM Plex Sans Medium', sans-serif",
  body: "'IBM Plex Sans Medium', sans-serif",
  mono: "'IBM Plex Mono Medium', monospace",
};

/** The dash pattern of the page: a 2 px dash every 18 px. */
export const DASH_PERIOD = 18;
export const FRAMES = 24;
export const FRAME_MS = 60;
const LOOP_S = (FRAMES * FRAME_MS) / 1000;

const fmtW = (w) => `${Math.round(w).toLocaleString('fr-FR').replace(/ | /g, ' ')} W`;
const fmtKwh = (k) =>
  `${k.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).replace(/ | /g, ' ')} kWh`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The page moves a dash (18 + W / 25) px per second. A loop must move whole
 * periods to join seamlessly: the nearest whole number of periods per loop.
 */
export const periodsPerLoop = (w) =>
  w < 5 ? 0 : Math.max(1, Math.round(((18 + w / 25) * LOOP_S) / DASH_PERIOD));

const strokeOf = (w) => (w >= 5 ? Math.min(12, 3 + w / 350) : 0);

/** What the picture shows, as text: its key changes when any of it changes. */
export function labelsOf(f, { now = new Date(), timeZone = 'Europe/Paris' } = {}) {
  return {
    sun: fmtW(f.production),
    home: fmtW(f.consumption),
    battery: f.remaining === null ? '—' : fmtKwh(f.remaining),
    sh: f.solarToHome >= 5 ? fmtW(f.solarToHome) : '',
    sb: f.charge >= 5 ? fmtW(f.charge) : '',
    bh: f.discharge >= 5 ? fmtW(f.discharge) : '',
    production: fmtW(f.production),
    consumption: fmtW(f.consumption),
    // Two cards, no sign: what goes to the virtual battery, what the house takes from it.
    injection: fmtW(f.charge),
    fromBattery: fmtW(f.discharge),
    auto: f.selfConsumption === null ? '—' : `${f.selfConsumption} %`,
    time: now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone }),
  };
}

export function pictureKey(f, theme, labels) {
  const sig = JSON.stringify([theme, labels, f.solarToHome, f.charge, f.discharge]);
  return `flux-${createHash('sha1').update(sig).digest('hex').slice(0, 16)}`;
}

/** One frame (`phase` in [0, 1)) of the picture; `phase` null: the still one. */
export function pictureSvg(f, { theme = 'dark', labels, phase = 0 } = {}) {
  const c = THEMES[theme] ?? THEMES.dark;
  const L = labels;
  const flows = [
    { d: 'M290 128 C 230 190, 170 230, 150 290', w: f.solarToHome, color: c.sun },
    { d: 'M350 128 C 410 190, 470 230, 490 290', w: f.charge, color: c.sun },
    { d: 'M440 352 L 200 352', w: f.discharge, color: c.store },
  ];
  const tracks = flows
    .map((x) => `<path d="${x.d}" fill="none" stroke="${c.track}" stroke-width="12" stroke-linecap="round"/>`)
    .join('');
  const moving = flows
    .filter((x) => x.w >= 5)
    .map((x) => {
      const offset = phase === null ? 0 : -(phase * periodsPerLoop(x.w) * DASH_PERIOD);
      return `<path d="${x.d}" fill="none" stroke="${x.color}" stroke-width="${strokeOf(x.w).toFixed(2)}" stroke-linecap="round" stroke-dasharray="2 16" stroke-dashoffset="${offset.toFixed(2)}"/>`;
    })
    .join('');
  const level = f.remaining === null ? 0 : Math.min(1, f.remaining / 500);
  const fillH = Math.max(4, 62 * level);

  // The diagram of the page (viewBox 640 x 430), scaled into the left part.
  const diagram = `<g transform="translate(-64 54) scale(1.452)">
${tracks}${moving}
<g transform="translate(320 70)">
  <circle cx="62" cy="-34" r="16" fill="${c.sun}" opacity="0.9"/>
  <path d="M-58 22 L-40 -26 L40 -26 L58 22 Z" fill="${c.surface}" stroke="${c.sun}" stroke-width="3" stroke-linejoin="round"/>
  <g stroke="${c.sun}" stroke-width="2"><line x1="-13" y1="-26" x2="-19" y2="22"/><line x1="13" y1="-26" x2="19" y2="22"/><line x1="-49" y1="-2" x2="49" y2="-2"/></g>
  <line x1="0" y1="22" x2="0" y2="40" stroke="${c.sun}" stroke-width="3"/>
  <text x="-8" y="-58" text-anchor="middle" font-family="${FONT.display}" font-size="16" fill="${c.ink}">Panneaux · 9 DS3</text>
  <text x="0" y="62" text-anchor="middle" font-family="${FONT.mono}" font-size="15" fill="${c.muted}">${esc(L.sun)}</text>
</g>
<g transform="translate(140 330)">
  <path d="M-46 4 L0 -36 L46 4 L46 46 L-46 46 Z" fill="${c.surface}" stroke="${c.home}" stroke-width="3" stroke-linejoin="round"/>
  <rect x="-12" y="18" width="24" height="28" fill="${c.home}" opacity="0.85"/>
  <text x="0" y="74" text-anchor="middle" font-family="${FONT.display}" font-size="16" fill="${c.ink}">Maison</text>
  <text x="0" y="94" text-anchor="middle" font-family="${FONT.mono}" font-size="15" fill="${c.muted}">${esc(L.home)}</text>
</g>
<g transform="translate(500 330)">
  <rect x="-40" y="-30" width="80" height="76" rx="10" fill="${c.surface}" stroke="${c.store}" stroke-width="3"/>
  <rect x="-14" y="-40" width="28" height="10" rx="3" fill="${c.store}"/>
  <rect x="-30" y="${(36 - fillH).toFixed(1)}" width="60" height="${fillH.toFixed(1)}" rx="4" fill="${c.store}" opacity="0.8"/>
  <path d="M-6 -12 L-14 10 L0 10 L-6 32 L14 2 L0 2 L6 -12 Z" fill="${c.surface}" stroke="${c.store}" stroke-width="2" stroke-linejoin="round"/>
  <text x="0" y="74" text-anchor="middle" font-family="${FONT.display}" font-size="16" fill="${c.ink}">Batterie virtuelle</text>
  <text x="0" y="94" text-anchor="middle" font-family="${FONT.mono}" font-size="15" fill="${c.muted}">Urban Solar · ${esc(L.battery)}</text>
</g>
<text x="168" y="196" text-anchor="end" font-family="${FONT.mono}" font-size="14" fill="${c.sun}">${esc(L.sh)}</text>
<text x="472" y="196" font-family="${FONT.mono}" font-size="14" fill="${c.sun}">${esc(L.sb)}</text>
<text x="320" y="340" text-anchor="middle" font-family="${FONT.mono}" font-size="14" fill="${c.store}">${esc(L.bh)}</text>
</g>`;

  // The four readings of the page, stacked on the right.
  const cards = [
    { label: 'PRODUCTION', value: L.production, color: c.sun },
    { label: 'CONSOMMATION', value: L.consumption, color: c.home },
    { label: 'INJECTION URBAN SOLAR', value: L.injection, color: c.grid },
    { label: 'CONSOMMATION SUR BATTERIE', value: L.fromBattery, color: c.store },
    { label: 'AUTOCONSOMMATION', value: L.auto, color: c.home },
    // The estimate kept by the flux-solaire service (the balance typed, + injected, - drawn).
    { label: 'CHARGE BATTERIE VIRTUELLE', value: L.battery, color: c.store },
  ];
  const x = 868;
  const w = 392;
  const h = 97;
  const gap = 11;
  const top = (SIZE.height - (cards.length * h + (cards.length - 1) * gap)) / 2 + 14;
  const readings = cards
    .map((card, i) => {
      const y = top + i * (h + gap);
      return `<g transform="translate(${x} ${y})">
  <rect x="0" y="0" width="${w}" height="${h}" rx="15" fill="${c.surface}"/>
  <rect x="0" y="0" width="5" height="${h}" rx="2.5" fill="${card.color}"/>
  <text x="28" y="34" font-family="${FONT.mono}" font-size="16.5" letter-spacing="1.5" fill="${c.muted}">${esc(card.label)}</text>
  <text x="28" y="78" font-family="${FONT.display}" font-size="40" fill="${c.ink}">${esc(card.value)}</text>
</g>`;
    })
    .join('');

  const clock = `<text x="${x + w}" y="${top - 22}" text-anchor="end" font-family="${FONT.mono}" font-size="17" fill="${c.muted}">Mis à jour ${esc(L.time)}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE.width} ${SIZE.height}" width="${SIZE.width}" height="${SIZE.height}">${diagram}${readings}${clock}</svg>`;
}
