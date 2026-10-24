// -----------------------------------------------------------------------------
// The picture of the flows as an animated WebP: FRAMES frames of the SVG with
// the dots moved along the arrows, joined in a loop. The Gladys core shows
// the bytes as they are (300 KB at most): checked here, with a still PNG as
// the fallback when the animation does not fit.
// -----------------------------------------------------------------------------

import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';
import { svgOf } from './flux.js';

const FRAMES = 20;
const DELAY_MS = 70;
const WIDTH = 800;
const MAX_BYTES = 300 * 1024;

const png = (svg) =>
  Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: WIDTH } }).render().asPng());

export async function renderImage(flows) {
  const frames = Array.from({ length: FRAMES }, (_, i) => png(svgOf(flows, i / FRAMES)));
  for (const quality of [75, 55, 40]) {
    const webp = await sharp(frames, { join: { animated: true } })
      .webp({ loop: 0, delay: Array(FRAMES).fill(DELAY_MS), quality, alphaQuality: 80, effort: 4 })
      .toBuffer();
    if (webp.length <= MAX_BYTES) {
      return webp.toString('base64');
    }
  }
  return png(svgOf(flows)).toString('base64');
}
