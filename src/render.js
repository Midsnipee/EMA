// -----------------------------------------------------------------------------
// The picture as an animated WebP: FRAMES frames of the SVG, the dashes moved
// along the arrows, joined in a seamless loop. Static parts are identical in
// every frame, so the encoder only stores what moves. The Gladys core shows
// the bytes as they are (300 KB at most): checked here, with the still frame
// as a PNG when the animation does not fit.
// -----------------------------------------------------------------------------

import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';
import { FRAMES, FRAME_MS, SIZE, pictureSvg } from './picture.js';

const FONT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fonts');
const MAX_BYTES = 300 * 1024;
/** Rendered narrower than the drawing: sharp enough in a card, light to encode. */
const WIDTH = 1120;

const OPTIONS = {
  fitTo: { mode: 'width', value: WIDTH },
  font: { fontDirs: [FONT_DIR], loadSystemFonts: false, defaultFontFamily: 'IBM Plex Sans Medium' },
  shapeRendering: 2,
  textRendering: 1,
};

const png = (svg) => Buffer.from(new Resvg(svg, OPTIONS).render().asPng());

export async function renderPicture(flows, { theme, labels }) {
  const moving = flows.solarToHome >= 5 || flows.charge >= 5 || flows.discharge >= 5;
  if (!moving) {
    return png(pictureSvg(flows, { theme, labels, phase: null })).toString('base64');
  }
  const frames = Array.from({ length: FRAMES }, (_, i) =>
    png(pictureSvg(flows, { theme, labels, phase: i / FRAMES })),
  );
  for (const quality of [85, 70, 55]) {
    const webp = await sharp(frames, { join: { animated: true } })
      .webp({ loop: 0, delay: Array(FRAMES).fill(FRAME_MS), quality, alphaQuality: 90, effort: 4, smartSubsample: true })
      .toBuffer();
    if (webp.length <= MAX_BYTES) {
      return webp.toString('base64');
    }
  }
  return frames[0].toString('base64');
}

export { SIZE };
