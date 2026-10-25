import test from 'node:test';
import assert from 'node:assert/strict';
import { stairBoxes, stairStepCount } from './stairMesh.ts';

test('stair steps are single risers climbing toward local -Z', () => {
  assert.equal(stairStepCount(1.8), 10);
  const steps = stairBoxes([1.2, 1.8, 3]);
  assert.equal(steps.length, 10);
  const first = steps[0];
  const top = steps[steps.length - 1];
  assert.ok(Math.abs(first.size[1] - 0.18) < 1e-6);
  assert.ok(Math.abs(top.size[1] - first.size[1]) < 1e-6);
  assert.ok(first.size[1] < 1.8);
  assert.ok(Math.abs(first.center[1] - first.size[1] / 2 + 0.9) < 1e-6);
  assert.ok(Math.abs(first.center[2] + first.size[2] / 2 - 1.5) < 1e-6);
  assert.ok(Math.abs(top.center[1] + top.size[1] / 2 - 0.9) < 1e-6);
  assert.ok(Math.abs(top.center[2] - top.size[2] / 2 + 1.5) < 1e-6);
  assert.equal(top.size[0], 1.2);
});
