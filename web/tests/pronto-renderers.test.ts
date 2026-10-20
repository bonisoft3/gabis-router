import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildElevationChartModel,
  buildSurfaceBreakdownModel,
  computeHoverReadout,
} from '../src/pronto/route-domain.js';
import renderElevationChart from '../public/shell/renderers/elevation-chart.js';
import renderSurfaceBreakdown from '../public/shell/renderers/surface-breakdown.js';

const uiActionSrc = fs.readFileSync(
  path.resolve(import.meta.dirname, '../public/shell/handlers/ui-action.js'),
  'utf8',
);
const reduceUiAction = (0, eval)(uiActionSrc) as (
  state: any,
  event: any,
) => { updates: Array<{ op: string; entity: string; id: string; row?: Record<string, any> }> };

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

test('Jessie ui-action reducer directly mutates waypoints, avoid areas, profile slots, and search results', () => {
  const baseState = {
    rows: {
      ui_state: [{ id: 'main', controls_class: '' }],
      profile_slot: [{ id: 'slot_0', slot_idx: 0, profile: 'fastbike-lowtraffic' }],
      waypoint: [
        { id: 'wp_0', idx: 0, lat: 51.5, lon: -0.12, name: 'London' },
        { id: 'wp_1', idx: 1, lat: 51.6, lon: -0.15, name: 'Barnet' },
        { id: 'wp_2', idx: 2, lat: 51.7, lon: -0.2, name: 'St Albans' },
      ],
      avoid_area: [{ id: 'av_0', idx: 0, lat: 51.55, lon: -0.14, radius: 250 }],
      search_result: [
        { id: 'sr_0', idx: 0, lat: 51.75, lon: -0.3, name: 'Watford', title: 'Watford' },
      ],
      route_bar: [{ id: 'bar_0', slot_idx: 0, hide_body: 'false' }],
    },
  };

  // 1. Reverse route directly puts reversed waypoints
  const rev = reduceUiAction(baseState, { type: 'click', from: 'btn-reverse-route' });
  const revPuts = rev.updates.filter((u) => u.entity === 'waypoint' && u.op === 'put');
  assert.equal(revPuts.length, 3);
  assert.equal(revPuts[0].row?.name, 'St Albans');
  assert.equal(revPuts[0].row?.badge_label, 'A');
  assert.equal(revPuts[2].row?.name, 'London');
  assert.equal(revPuts[2].row?.badge_label, 'B');

  // 2. Delete waypoint directly deletes tail and re-indexes remaining
  const del = reduceUiAction(baseState, { type: 'click', from: 'wp-del-1' });
  const delDeletes = del.updates.filter((u) => u.entity === 'waypoint' && u.op === 'delete');
  const delPuts = del.updates.filter((u) => u.entity === 'waypoint' && u.op === 'put');
  assert.equal(delDeletes.length, 1);
  assert.equal(delDeletes[0].id, 'wp_2');
  assert.equal(delPuts.length, 2);
  assert.equal(delPuts[1].row?.name, 'St Albans');

  // 3. Cycle avoid radius directly puts updated radius
  const rad = reduceUiAction(baseState, { type: 'click', from: 'avoid-rad-0' });
  assert.equal(rad.updates.length, 1);
  assert.equal(rad.updates[0].entity, 'avoid_area');
  assert.equal(rad.updates[0].row?.radius, 500);
  assert.equal(rad.updates[0].row?.radius_label, '500 m');

  // 4. Add comparison profile slot directly puts slot_0 and slot_1
  const addSlot = reduceUiAction(baseState, { type: 'click', from: 'btn-add-compare-profile' });
  const slotPuts = addSlot.updates.filter((u) => u.entity === 'profile_slot' && u.op === 'put');
  assert.equal(slotPuts.length, 2);
  assert.equal(slotPuts[1].id, 'slot_1');
  assert.equal(slotPuts[1].row?.profile, 'fastbike-verylowtraffic');

  // 5. Pick search result directly inserts waypoint and deletes search_result rows
  const pick = reduceUiAction(baseState, { type: 'click', from: 'sr-end-0' });
  const srDels = pick.updates.filter((u) => u.entity === 'search_result' && u.op === 'delete');
  const wpPuts = pick.updates.filter((u) => u.entity === 'waypoint' && u.op === 'put');
  assert.equal(srDels.length, 1);
  assert.equal(wpPuts[2].row?.name, 'Watford');

  // 6. Mutation fold reconciles out-of-sync profile_slot and ui_state chrome
  const fold = reduceUiAction(baseState, { type: 'mutation' });
  assert.ok(fold.updates.some((u) => u.entity === 'profile_slot' && u.op === 'put'));
  assert.ok(fold.updates.some((u) => u.entity === 'ui_state' && u.op === 'patch'));
});
