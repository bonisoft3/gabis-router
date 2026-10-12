import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPlaceProperties } from '../src/geocoding.ts';

test('formatPlaceProperties formats point of interest with district', () => {
  const props = {
    name: 'Graham Greene',
    street: 'Clapham Common North Side',
    district: 'Clapham',
    city: 'London',
    country: 'United Kingdom',
  };
  const result = formatPlaceProperties(props);
  assert.equal(result.title, 'Graham Greene');
  assert.equal(result.subtitle, 'Clapham Common North Side, Clapham, London, United Kingdom');
  assert.equal(result.name, 'Graham Greene, Clapham');
});

test('formatPlaceProperties formats postcode with city', () => {
  const props = {
    osm_value: 'postcode',
    name: 'CA12 4ET',
    city: 'Keswick',
    county: 'Cumberland',
    country: 'United Kingdom',
  };
  const result = formatPlaceProperties(props);
  assert.equal(result.title, 'Keswick (CA12 4ET)');
  assert.equal(result.subtitle, 'Cumberland, United Kingdom');
  assert.equal(result.name, 'Keswick (CA12 4ET)');
});

test('formatPlaceProperties formats street address when name equals housenumber', () => {
  const props = {
    name: '10',
    housenumber: '10',
    street: 'Downing Street',
    city: 'London',
  };
  const result = formatPlaceProperties(props);
  assert.equal(result.title, '10 Downing Street');
  assert.equal(result.subtitle, 'London');
  assert.equal(result.name, '10 Downing Street, London');
});

test('formatPlaceProperties handles place without specific name', () => {
  const props = {
    district: 'Kew',
    city: 'London',
    country: 'United Kingdom',
  };
  const result = formatPlaceProperties(props);
  assert.equal(result.title, 'Kew');
  assert.equal(result.subtitle, 'London, United Kingdom');
  assert.equal(result.name, 'Kew, London');
});

test('cachePlaceName populates reverseGeocode cache', async () => {
  const { cachePlaceName, reverseGeocode } = await import('../src/geocoding.ts');
  cachePlaceName(51.5074, -0.1278, 'Trafalgar Square, London');
  const cached = await reverseGeocode(51.5074, -0.1278);
  assert.equal(cached, 'Trafalgar Square, London');
});
