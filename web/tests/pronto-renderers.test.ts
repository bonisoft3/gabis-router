import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildElevationChartModel,
  buildSurfaceBreakdownModel,
  computeHoverReadout,
} from '../src/pronto/route-domain.js';
import renderElevationChart from '../public/shell/renderers/elevation-chart.js';
import renderSurfaceBreakdown from '../public/shell/renderers/surface-breakdown.js';

const h = (tag: string, attrs: Record<string, any> = {}, ...children: any[]) => ({
  tag,
  attrs,
  children,
});

const SAMPLE_ROUTE: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        'track-length': '1200',
        'total-time': '240',
        'filtered ascend': '35',
        segments: [
          { from: 0, to: 600, surface: 'asphalt', highway: 'cycleway', noise: 1, traffic: 1 },
          {
            from: 600,
            to: 1200,
            surface: 'gravel',
            highway: 'residential',
            noise: 3,
            traffic: 2,
            maxspeed: 30,
          },
        ],
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [-0.1276, 51.5072, 12],
          [-0.122, 51.509, 24],
          [-0.116, 51.511, 38],
        ],
      },
    },
  ],
};

test('buildElevationChartModel and Jessie elevation-chart renderer produce valid SVG VNode tree', () => {
  const model = buildElevationChartModel(SAMPLE_ROUTE, 'metric', 0, false);
  assert.ok(model, 'Expected elevation model to be built');
  assert.ok(model.specJson.length > 0);

  const vnodes = renderElevationChart(model.specJson);
  assert.ok(Array.isArray(vnodes));
  assert.equal(vnodes.length, 1);
  const vnode = vnodes[0];
  assert.equal(vnode.tag, 'svg');
  assert.equal(vnode.attrs.viewBox, '0 0 600 96');

  const childTags = vnode.children.map((c: any) => c.tag);
  assert.ok(childTags.includes('defs'));
  assert.ok(childTags.includes('path'));
  assert.ok(childTags.includes('line'));
  assert.ok(childTags.includes('circle'));

  const readout = computeHoverReadout(model, 0.5, 'metric');
  assert.equal(readout.fields.hide_readout, 'false');
  assert.ok(readout.fields.hover_ele.includes('m'));
  assert.equal(readout.fields.hide_hover_surf, 'false');
});

test('buildSurfaceBreakdownModel and Jessie surface-breakdown renderer produce valid VNode rows', () => {
  const surfModel = buildSurfaceBreakdownModel(SAMPLE_ROUTE, 'metric', {
    rowTitle: 'Surface',
    label: 'Paved',
  });
  assert.ok(surfModel.specJson.length > 0);
  assert.equal(surfModel.rows.length, 5);

  const vnodes = renderSurfaceBreakdown(surfModel.specJson, { h });
  assert.ok(Array.isArray(vnodes));
  assert.equal(vnodes.length, 5);
  assert.equal(vnodes[0].tag, 'div');
  assert.equal(vnodes[0].attrs.class, 'profile-bar-row');
});
