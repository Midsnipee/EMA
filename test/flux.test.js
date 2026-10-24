import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { validateWidgetContent, validateWidgetImage } from '@gladysassistant/integration-sdk';
import { buildDevice, flowsOf, imageKeyOf, statesOf, svgOf, widgetContent } from '../src/flux.js';

const sample = {
  ok: true,
  production: { watts: 816, changedAt: new Date().toISOString() },
  grid: { watts: -600, changedAt: new Date().toISOString() },
  battery: { kwh: 123.456 },
};

test('the flows of the real reading: 816 W produced, 600 W injected', () => {
  const f = flowsOf(sample);
  assert.deepEqual(
    [f.production, f.consumption, f.solarToHome, f.charge, f.discharge, f.remaining, f.selfConsumption],
    [816, 216, 216, 600, 0, 123.46, 26],
  );
  const night = flowsOf({ ...sample, production: { watts: 0 }, grid: { watts: 450 } });
  assert.deepEqual([night.consumption, night.discharge, night.charge, night.selfConsumption], [450, 450, 0, null]);
});

test('the device and its states', () => {
  const d = buildDevice('ext:x:house:main');
  assert.equal(d.features.length, 7);
  assert.equal(statesOf('ext:x:house:main', flowsOf(sample)).length, 7);
});

test('the widget content and image pass the core rules', () => {
  const f = flowsOf(sample);
  const png = Buffer.from(new Resvg(svgOf(f), { fitTo: { mode: 'width', value: 800 } }).render().asPng());
  writeFileSync(process.env.PREVIEW ?? '/tmp/flux-preview.png', png);
  assert.deepEqual(validateWidgetImage(png.toString('base64')), []);
  for (const created of [true, false]) {
    const content = widgetContent({ flows: f, deviceId: 'ext:x:house:main', created, imageKey: imageKeyOf(f), pageUrl: 'https://flux.lan' });
    assert.deepEqual(validateWidgetContent(content), []);
  }
  assert.deepEqual(validateWidgetContent(widgetContent({ flows: null, error: 'refused' })), []);
  assert.notEqual(imageKeyOf(f), imageKeyOf(flowsOf({ ...sample, grid: { watts: 300 } })));
});

test('the animated WebP passes the core image rules', async () => {
  const { renderImage } = await import('../src/render.js');
  const b64 = await renderImage(flowsOf(sample));
  const bytes = Buffer.from(b64, 'base64');
  assert.equal(bytes.toString('ascii', 12, 16), 'VP8X', 'an animated WebP, not the PNG fallback');
  assert.deepEqual(validateWidgetImage(b64), []);
});
