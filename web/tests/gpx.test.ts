import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeFilteredElevation, routeToGpx } from '../src/pronto/route-domain.js';

describe('computeFilteredElevation', () => {
  it('accumulates gentle climbs with < 0.5 m steps without dropping them', () => {
    // 100 steps of +0.3 m = +30 m climb
    const ele = Array.from({ length: 101 }, (_, i) => i * 0.3);
    const { ascentM, descentM } = computeFilteredElevation(ele);
    assert.ok(Math.abs(ascentM - 30) < 1e-6);
    assert.ok(Math.abs(descentM) < 1e-6);
  });

  it('filters out small elevation ripples smaller than the 5 m hysteresis band', () => {
    // Climb 20 m, dip 2 m, climb 2 m (within 5 m deadband), then descend 20 m
    const ele = [100, 120, 118, 120, 100];
    const { ascentM, descentM } = computeFilteredElevation(ele);
    assert.equal(ascentM, 20);
    assert.equal(descentM, 20);
  });

  it('counts climb after a descent exceeding the 5 m hysteresis threshold', () => {
    // Start 100, climb to 120 (+20), descend to 110 (-10, saturates -5 filter), climb to 125 (+10 after clearing -5)
    const ele = [100, 120, 110, 125];
    const { ascentM, descentM } = computeFilteredElevation(ele);
    assert.equal(ascentM, 30);
    assert.equal(descentM, 5);
  });
});

describe('routeToGpx', () => {
  it('escapes XML special characters and formats coordinates and elevation', () => {
    const geojson: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            'track-length': 12345,
            'total-time': 1800,
            'filtered ascend': 250,
          },
          geometry: {
            type: 'LineString',
            coordinates: [
              [8.681495, 49.41461, 112.4],
              [8.686507, 49.41943, 118.9],
            ],
          },
        },
      ],
    };

    const gpx = routeToGpx(geojson, 'Ride & <Test> "1"');
    assert.ok(gpx.includes('<name>Ride &amp; &lt;Test&gt; &quot;1&quot;</name>'));
    assert.ok(gpx.includes('Distance: 12.35 km, Time: 30 min, Ascend: 250 m'));
    assert.ok(gpx.includes('<trkpt lat="49.414610" lon="8.681495">'));
    assert.ok(gpx.includes('<ele>112.40</ele>'));
  });
});
