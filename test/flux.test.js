import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent, validateWidgetImage } from '@gladysassistant/integration-sdk';
import { buildDevice, flowsOf, statesOf, widgetContent } from '../src/flux.js';
import { labelsOf, periodsPerLoop, pictureKey } from '../src/picture.js';
import { renderPicture } from '../src/render.js';

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
  assert.equal(buildDevice('ext:x:house:main').features.length, 7);
  assert.equal(statesOf('ext:x:house:main', flowsOf(sample)).length, 7);
});

test('the labels and the key follow what the picture shows', () => {
  const f = flowsOf(sample);
  const now = new Date('2026-10-24T10:52:00Z');
  const L = labelsOf(f, { now });
  assert.deepEqual([L.sun, L.home, L.sb, L.bh, L.injection, L.fromBattery, L.auto, L.time], ['816 W', '216 W', '600 W', '', '600 W', '0 W', '26 %', '12:52']);
  assert.notEqual(pictureKey(f, 'dark', L), pictureKey(f, 'light', L));
  assert.equal(periodsPerLoop(0), 0);
  assert.ok(periodsPerLoop(3000) > periodsPerLoop(200));
});

test('the animated picture and the widget pass the core rules', async () => {
  const f = flowsOf(sample);
  for (const theme of ['dark', 'light']) {
    const b64 = await renderPicture(f, { theme, labels: labelsOf(f) });
    assert.equal(Buffer.from(b64, 'base64').toString('ascii', 12, 16), 'VP8X', 'animated WebP');
    assert.deepEqual(validateWidgetImage(b64), []);
  }
  const still = flowsOf({ ...sample, production: { watts: 0 }, grid: { watts: 0 } });
  assert.deepEqual(validateWidgetImage(await renderPicture(still, { theme: 'dark', labels: labelsOf(still) })), []);
  for (const content of [
    widgetContent({ flows: f, imageKey: 'flux-abc', pageUrl: 'https://flux.lan', error: 'timeout' }),
    widgetContent({ flows: f, imageKey: 'flux-abc' }),
    widgetContent({ flows: null, error: 'refused' }),
  ]) {
    assert.deepEqual(validateWidgetContent(content), []);
  }
});
