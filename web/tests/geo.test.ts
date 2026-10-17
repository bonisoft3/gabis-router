import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCoordinateInput,
  closestLeg,
  legIndexAt,
  distToSegmentSq,
} from '../src/utils/geo.ts';

test('parseCoordinateInput parses comma-separated and space-separated coordinates', () => {
  const c1 = parseCoordinateInput('51.5074, -0.1278');
  assert.ok(c1);
  assert.equal(c1.lat, 51.5074);
  assert.equal(c1.lon, -0.1278);

  const c2 = parseCoordinateInput('55.9533 -3.1883');
  assert.ok(c2);
  assert.equal(c2.lat, 55.9533);
  assert.equal(c2.lon, -3.1883);
});

test('parseCoordinateInput rejects out-of-range or text queries', () => {
  assert.equal(parseCoordinateInput('London Bridge'), null);
  assert.equal(parseCoordinateInput('95.0, -0.12'), null);
  assert.equal(parseCoordinateInput('51.5, 195.0'), null);
});

test('distToSegmentSq computes zero for point on segment', () => {
  const d = distToSegmentSq(0.5, 0.5, 0, 0, 1, 1);
  assert.ok(d < 1e-12);
});

test('closestLeg picks the right segment between multiple waypoints', () => {
  const waypoints = [
    { lat: 51.5, lon: -0.2 },
    { lat: 51.5, lon: -0.1 },
    { lat: 51.5, lon: 0.0 },
  ];
  // Point between waypoint 0 and 1 -> leg 0
  assert.equal(closestLeg(waypoints, -0.15, 51.501), 0);
  // Point between waypoint 1 and 2 -> leg 1
  assert.equal(closestLeg(waypoints, -0.05, 51.501), 1);
});

test('legIndexAt maps route geometry vertex back to the corresponding waypoint leg', () => {
  const waypoints = [
    { lat: 51.5, lon: -0.2 },
    { lat: 51.5, lon: -0.1 },
    { lat: 51.5, lon: 0.0 },
  ];
  const routeCoords = [
    [-0.2, 51.5],
    [-0.15, 51.5],
    [-0.1, 51.5],
    [-0.05, 51.5],
    [0.0, 51.5],
  ];

  assert.equal(legIndexAt(routeCoords, waypoints, -0.15, 51.5005), 0);
  assert.equal(legIndexAt(routeCoords, waypoints, -0.05, 51.5005), 1);
});
