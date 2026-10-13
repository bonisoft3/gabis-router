import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySpeedLimit,
  SPEED_LIMIT_META,
  type SpeedLimitCategory,
} from '../src/utils/classification.ts';

test('classifySpeedLimit: car-free infrastructure', () => {
  const carFreeHighways = ['cycleway', 'path', 'footway', 'pedestrian', 'bridleway', 'track', 'steps'];
  for (const h of carFreeHighways) {
    assert.equal(classifySpeedLimit(undefined, h), 'car_free');
    // Even if an explicit speed tag is present on a cycleway or path, it remains car-free
    assert.equal(classifySpeedLimit(30, h), 'car_free');
    assert.equal(classifySpeedLimit(50, h), 'car_free');
  }
});

test('classifySpeedLimit: explicit speed limits (km/h from RD5)', () => {
  // <= 35 km/h -> 20 mph (e.g. 20, 30 km/h, or 20mph)
  assert.equal(classifySpeedLimit(20, 'residential'), '20mph');
  assert.equal(classifySpeedLimit(30, 'secondary'), '20mph');
  assert.equal(classifySpeedLimit(35, 'primary'), '20mph');

  // 36 - 55 km/h -> 30 mph (e.g. 50 km/h or 30mph)
  assert.equal(classifySpeedLimit(40, 'tertiary'), '30mph');
  assert.equal(classifySpeedLimit(50, 'secondary'), '30mph');
  assert.equal(classifySpeedLimit(55, 'primary'), '30mph');

  // 56 - 75 km/h -> 40 mph (e.g. 60, 70 km/h or 40mph)
  assert.equal(classifySpeedLimit(60, 'primary'), '40mph');
  assert.equal(classifySpeedLimit(70, 'secondary'), '40mph');

  // 76 - 95 km/h -> 50 mph (e.g. 80, 90 km/h or 50mph)
  assert.equal(classifySpeedLimit(80, 'primary'), '50mph');
  assert.equal(classifySpeedLimit(90, 'trunk'), '50mph');

  // 96 - 105 km/h -> 60 mph (e.g. 100 km/h or 60mph)
  assert.equal(classifySpeedLimit(100, 'primary'), '60mph');

  // > 105 km/h -> 70 mph (e.g. 110, 120, 130 km/h or 70mph)
  assert.equal(classifySpeedLimit(110, 'trunk'), '70mph');
  assert.equal(classifySpeedLimit(120, 'motorway'), '70mph');
  assert.equal(classifySpeedLimit(130, 'motorway'), '70mph');
});

test('classifySpeedLimit: fallback inference from highway when maxspeed is missing', () => {
  assert.equal(classifySpeedLimit(0, 'residential'), '20mph');
  assert.equal(classifySpeedLimit(undefined, 'living_street'), '20mph');
  assert.equal(classifySpeedLimit(undefined, 'service'), '20mph');

  assert.equal(classifySpeedLimit(0, 'tertiary'), '30mph');
  assert.equal(classifySpeedLimit(undefined, 'unclassified'), '30mph');

  assert.equal(classifySpeedLimit(0, 'secondary'), '40mph');
  assert.equal(classifySpeedLimit(undefined, 'secondary_link'), '40mph');

  assert.equal(classifySpeedLimit(0, 'primary'), '50mph');
  assert.equal(classifySpeedLimit(undefined, 'primary_link'), '50mph');

  assert.equal(classifySpeedLimit(0, 'trunk'), '60mph');

  assert.equal(classifySpeedLimit(0, 'motorway'), '70mph');
  assert.equal(classifySpeedLimit(undefined, 'motorway_link'), '70mph');
});

test('classifySpeedLimit: all categories have valid metadata labels and colors', () => {
  const categories: SpeedLimitCategory[] = [
    'car_free',
    '20mph',
    '30mph',
    '40mph',
    '50mph',
    '60mph',
    '70mph',
  ];

  for (const cat of categories) {
    assert.ok(SPEED_LIMIT_META[cat], `Missing meta for ${cat}`);
    assert.ok(SPEED_LIMIT_META[cat].label, `Missing label for ${cat}`);
    assert.ok(SPEED_LIMIT_META[cat].color, `Missing color for ${cat}`);
  }
});
