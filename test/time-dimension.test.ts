import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  MAX_FRAMES,
  buildTimeBlock,
  capabilitiesUrlFor,
  findLayerTimeDimension,
  formatInstant,
  parseIsoDuration,
  parseTimeExtent
} from '../dist/utils/time-dimension.js';
import { TimeDimensionPoller, type PollTarget } from '../dist/utils/time-poller.js';

const NOW = Date.parse('2026-09-25T04:25:00Z');
const MIN = 60000;

// Shapes observed in the real capabilities documents (see the catalog research).
const NCEP_WMS = `<WMS_Capabilities><Capability><Layer><Title>root</Title>
  <Layer queryable="1"><Name>conus_bref_qcd</Name><Title>Radar</Title>
    <Dimension name="time" default="2026-09-25T04:20:57Z" units="ISO8601" nearestValue="1">2026-09-25T02:22:57.000Z,2026-09-25T03:20:57.000Z,2026-09-25T04:20:57.000Z</Dimension>
  </Layer></Layer></Capability></WMS_Capabilities>`;

const GEOSERVER_PREFIXED = `<Layer><Name>dwd:Niederschlagsradar</Name>
  <Dimension name="time" default="current" units="ISO8601">2026-09-21T00:00:00.000Z/2026-09-25T06:15:00.000Z/PT5M</Dimension>
  <Dimension name="REFERENCE_TIME" default="current">2026-09-25T04:00:00.000Z</Dimension></Layer>`;

const GIBS_WMS = `<Layer><Name>OTHER_Layer</Name><Dimension name="time">2020-01-01/2020-01-02/P1D</Dimension></Layer>
<Layer><Name>GOES-East_ABI_GeoColor</Name>
  <Dimension name="time" units="ISO8601" default="2026-09-25T03:30:00Z" nearestValue="0">2026-08-10T14:00:00Z/2026-08-10T14:00:00Z/PT10M,2026-09-25T01:00:00Z/2026-09-25T02:00:00Z/PT10M,2026-09-25T02:40:00Z/2026-09-25T03:30:00Z/PT10M</Dimension>
</Layer>`;

const WMTS = `<Contents><Layer><ows:Title>x</ows:Title><ows:Identifier>goes_ir</ows:Identifier>
  <Dimension><ows:Identifier>Time</ows:Identifier><Default>2026-09-25T04:00:00Z</Default>
    <Value>2026-09-25T03:50:00Z</Value><Value>2026-09-25T04:00:00Z</Value></Dimension>
</Layer></Contents>`;

const WMS_111 = `<Layer><Name>old_radar</Name>
  <Dimension name="time" units="ISO8601"/>
  <Extent name="time" default="2026-09-25T04:00:00Z">2026-09-25T03:00:00Z,2026-09-25T04:00:00Z</Extent>
</Layer>`;

describe('parseIsoDuration', () => {
  it('reads the periods services use', () => {
    assert.strictEqual(parseIsoDuration('PT5M'), 5 * MIN);
    assert.strictEqual(parseIsoDuration('PT6M'), 6 * MIN);
    assert.strictEqual(parseIsoDuration('PT1H'), 60 * MIN);
    assert.strictEqual(parseIsoDuration('P1D'), 24 * 60 * MIN);
    assert.strictEqual(parseIsoDuration('P1DT2H30M'), (26 * 60 + 30) * MIN);
    assert.strictEqual(parseIsoDuration('PT1S'), 1000);
  });

  it('rejects non-durations and zero', () => {
    for (const bad of ['P', 'PT', 'PT0M', '5M', '', 'P1DT']) {
      assert.strictEqual(parseIsoDuration(bad), null, bad);
    }
  });
});

describe('findLayerTimeDimension', () => {
  it('finds a WMS 1.3 dimension on the named layer', () => {
    assert.match(findLayerTimeDimension(NCEP_WMS, 'conus_bref_qcd') ?? '', /^2026-09-25T02:22:57/);
  });

  it('matches a GeoServer workspace-prefixed name, and ignores other dimensions', () => {
    assert.strictEqual(
      findLayerTimeDimension(GEOSERVER_PREFIXED, 'Niederschlagsradar'),
      '2026-09-21T00:00:00.000Z/2026-09-25T06:15:00.000Z/PT5M'
    );
    assert.ok(findLayerTimeDimension(GEOSERVER_PREFIXED, 'dwd:Niederschlagsradar'));
  });

  it("never takes another layer's dimension", () => {
    assert.match(findLayerTimeDimension(GIBS_WMS, 'GOES-East_ABI_GeoColor') ?? '', /^2026-08-10/);
    assert.strictEqual(findLayerTimeDimension(NCEP_WMS, 'no_such_layer'), null);
  });

  it('never matches the same layer name in another workspace', () => {
    const xml = `<Layer><Name>a:radar</Name><Dimension name="time">2026-01-01T00:00:00Z</Dimension></Layer>
      <Layer><Name>radar</Name><Dimension name="time">2026-02-02T00:00:00Z</Dimension></Layer>`;
    assert.strictEqual(findLayerTimeDimension(xml, 'b:radar'), '2026-02-02T00:00:00Z');
    assert.strictEqual(findLayerTimeDimension(xml, 'a:radar'), '2026-01-01T00:00:00Z');
    assert.strictEqual(findLayerTimeDimension(xml, 'radar'), '2026-02-02T00:00:00Z');
  });

  it('skips a self-closed time declaration instead of taking the next dimension', () => {
    const xml = `<Layer><Name>x</Name><Dimension name="time" units="ISO8601"/>
      <Dimension name="elevation" units="m">0,10</Dimension></Layer>`;
    assert.strictEqual(findLayerTimeDimension(xml, 'x'), null);
  });

  it('reads WMTS dimensions and WMS 1.1.1 extents', () => {
    assert.strictEqual(
      findLayerTimeDimension(WMTS, 'goes_ir'),
      '2026-09-25T03:50:00Z,2026-09-25T04:00:00Z'
    );
    assert.strictEqual(
      findLayerTimeDimension(WMS_111, 'old_radar'),
      '2026-09-25T03:00:00Z,2026-09-25T04:00:00Z'
    );
  });
});

describe('parseTimeExtent + buildTimeBlock', () => {
  const observation = { kind: 'observation', window: 'PT2H' };

  it('keeps an explicit list within the window, newest last', () => {
    const extent = parseTimeExtent(
      '2026-09-25T01:00:00Z, 2026-09-25T02:30:00Z,2026-09-25T04:20:00Z,2026-09-25T03:00:00Z',
      NOW
    );
    assert.deepStrictEqual(buildTimeBlock(extent!, observation, NOW), {
      current: true,
      from: '2026-09-25T02:30:00Z',
      to: '2026-09-25T04:20:00Z',
      values: ['2026-09-25T02:30:00Z', '2026-09-25T03:00:00Z', '2026-09-25T04:20:00Z']
    });
  });

  it('sends a regular interval as from/to/step, on the service grid', () => {
    // Years of frames (EUMETSAT) must only be expanded over the window.
    const extent = parseTimeExtent('2024-09-23T00:00:00Z/2026-09-25T04:20:00Z/PT10M', NOW);
    assert.deepStrictEqual(buildTimeBlock(extent!, observation, NOW), {
      current: true,
      from: '2026-09-25T02:30:00Z',
      to: '2026-09-25T04:20:00Z',
      step: 10 * MIN
    });
  });

  it('keeps an off-hour grid (ECCC every 6 minutes from :24)', () => {
    const extent = parseTimeExtent('2026-09-25T01:24:00Z/2026-09-25T04:24:00Z/PT6M', NOW);
    const block = buildTimeBlock(extent!, observation, NOW);
    assert.strictEqual(block?.from, '2026-09-25T02:30:00Z');
    assert.strictEqual(block.to, '2026-09-25T04:24:00Z');
  });

  it('keeps a nowcast that runs past now (DWD)', () => {
    const extent = parseTimeExtent('2026-09-21T00:00:00Z/2026-09-25T06:25:00Z/PT5M', NOW);
    assert.strictEqual(buildTimeBlock(extent!, observation, NOW)?.to, '2026-09-25T06:25:00Z');
  });

  it('lists the frames of intervals with gaps (NASA GIBS)', () => {
    const extent = parseTimeExtent(
      '2026-09-25T01:00:00Z/2026-09-25T02:00:00Z/PT10M,2026-09-25T02:40:00Z/2026-09-25T03:00:00Z/PT10M',
      NOW
    );
    // The first interval is entirely before the 2-hour window.
    assert.deepStrictEqual(buildTimeBlock(extent!, observation, NOW)?.values, [
      '2026-09-25T02:40:00Z',
      '2026-09-25T02:50:00Z',
      '2026-09-25T03:00:00Z'
    ]);
  });

  it('reads now/current/latest interval ends as the present', () => {
    const extent = parseTimeExtent('2026-09-25T03:00:00Z/now/PT30M', NOW);
    assert.strictEqual(buildTimeBlock(extent!, observation, NOW)?.to, '2026-09-25T04:00:00Z');
  });

  it('starts a forecast at the frame in force now', () => {
    const extent = parseTimeExtent('2026-09-25T00:00:00Z/2026-09-30T00:00:00Z/PT1H', NOW);
    const block = buildTimeBlock(extent!, { kind: 'forecast', window: 'P1D' }, NOW);
    assert.strictEqual(block?.from, '2026-09-25T04:00:00Z');
    assert.strictEqual(block.to, '2026-09-26T04:00:00Z');
    assert.strictEqual(block.step, 60 * MIN);
  });

  it('caps the frame count, keeping the frames nearest now', () => {
    const extent = parseTimeExtent('2026-09-25T00:00:00Z/2026-09-25T04:25:00Z/PT1S', NOW);
    const block = buildTimeBlock(extent!, observation, NOW);
    assert.ok(block?.step);
    assert.strictEqual(block.to, '2026-09-25T04:25:00Z');
    const frames = (Date.parse(block.to!) - Date.parse(block.from!)) / block.step + 1;
    assert.strictEqual(frames, MAX_FRAMES);
  });

  it('keeps the live frame over a long observation window', () => {
    const extent = parseTimeExtent('2026-09-01T00:00:00Z/2026-09-25T04:25:00Z/PT5M', NOW);
    const block = buildTimeBlock(extent!, { kind: 'observation', window: 'P7D' }, NOW);
    assert.strictEqual(block?.to, '2026-09-25T04:25:00Z');
  });

  it('bounds an observation interval that runs far into the future', () => {
    const extent = parseTimeExtent('2026-09-25T00:00:00Z/2099-12-31T00:00:00Z/PT10M', NOW);
    const block = buildTimeBlock(extent!, observation, NOW);
    assert.ok(Date.parse(block!.to!) <= NOW + 2 * 3600000);
    assert.ok(Date.parse(block!.from!) <= NOW);
  });

  it('keeps the frame in force when a long forecast is capped', () => {
    const extent = parseTimeExtent('2026-09-25T00:00:00Z/2026-10-05T00:00:00Z/PT10M', NOW);
    const block = buildTimeBlock(extent!, { kind: 'forecast', window: 'P5D' }, NOW);
    assert.strictEqual(block?.from, '2026-09-25T04:20:00Z');
  });

  it('keeps the frame in force for irregular forecasts and lone instants', () => {
    const list = parseTimeExtent(
      '2026-09-25T00:00:00Z,2026-09-25T03:00:00Z,2026-09-25T04:00:00Z,2026-09-25T06:00:00Z',
      NOW
    );
    assert.strictEqual(
      buildTimeBlock(list!, { kind: 'forecast' }, NOW)?.from,
      '2026-09-25T04:00:00Z'
    );
    const mixed = parseTimeExtent(
      '2026-09-25T00:00:00Z/2026-09-25T03:00:00Z/PT3H,2026-09-25T06:00:00Z',
      NOW
    );
    assert.deepStrictEqual(buildTimeBlock(mixed!, { kind: 'forecast' }, NOW)?.values, [
      '2026-09-25T03:00:00Z',
      '2026-09-25T06:00:00Z'
    ]);
  });

  it('reads timestamps without a zone as UTC', () => {
    const extent = parseTimeExtent('2026-09-25T04:00:00', NOW);
    assert.strictEqual(buildTimeBlock(extent!, observation, NOW)?.to, '2026-09-25T04:00:00Z');
  });

  it('returns null when nothing falls in the window, or the text is junk', () => {
    const stale = parseTimeExtent('2020-01-01T00:00:00Z,2020-01-02T00:00:00Z', NOW);
    assert.strictEqual(buildTimeBlock(stale!, observation, NOW), null);
    assert.strictEqual(parseTimeExtent('not a time, nor this', NOW), null);
    assert.strictEqual(parseTimeExtent('', NOW), null);
  });

  it('formats instants without zero milliseconds', () => {
    assert.strictEqual(
      formatInstant(Date.parse('2026-09-25T04:20:57.000Z')),
      '2026-09-25T04:20:57Z'
    );
    assert.strictEqual(
      formatInstant(Date.parse('2026-09-25T04:20:57.500Z')),
      '2026-09-25T04:20:57.500Z'
    );
  });
});

describe('capabilitiesUrlFor', () => {
  it('keeps the service URL and adds the request', () => {
    const url = new URL(capabilitiesUrlFor('https://example.com/geoserver/ows?map=x', 'WMS'));
    assert.strictEqual(url.searchParams.get('map'), 'x');
    assert.strictEqual(url.searchParams.get('request'), 'GetCapabilities');
    assert.strictEqual(url.searchParams.get('version'), '1.3.0');
  });
});

describe('TimeDimensionPoller', () => {
  const target: PollTarget = {
    catalogId: 'nws-radar-conus',
    capabilitiesUrl: 'https://example.com/caps',
    layer: 'conus_bref_qcd',
    window: { kind: 'observation', window: 'PT3H' },
    refreshInterval: 300000
  };

  function poller(
    fetchText: (url: string) => Promise<string>,
    changes: string[] = [],
    now: () => number = () => NOW
  ) {
    return new TimeDimensionPoller(
      (id, time) => changes.push(`${id} ${time?.to ?? 'withdrawn'}`),
      () => {},
      fetchText,
      now
    );
  }

  it('reports a new timeline, and only when it changes', async () => {
    const changes: string[] = [];
    let xml = NCEP_WMS;
    let clock = NOW;
    const p = poller(
      () => Promise.resolve(xml),
      changes,
      () => clock
    );
    try {
      p.sync([target]);
      await p.poll(target);
      await p.poll(target);
      assert.deepStrictEqual(changes, ['nws-radar-conus 2026-09-25T04:20:57Z']);
      clock += 120000; // past the shared-download window
      xml = NCEP_WMS.replace(
        '04:20:57.000Z</Dimension>',
        '04:20:57.000Z,2026-09-25T04:24:00Z</Dimension>'
      );
      await p.poll(target);
      assert.deepStrictEqual(changes.at(-1), 'nws-radar-conus 2026-09-25T04:24:00Z');
      assert.strictEqual(p.get('nws-radar-conus')?.to, '2026-09-25T04:24:00Z');
    } finally {
      p.stop();
    }
  });

  it('polls on demand: at the first read, then not again within the interval', async () => {
    let fetches = 0;
    let clock = NOW;
    const p = poller(
      () => {
        fetches++;
        return Promise.resolve(NCEP_WMS);
      },
      [],
      () => clock
    );
    try {
      p.sync([target]);
      assert.strictEqual(fetches, 0, 'nothing is fetched before a client reads the chart');
      p.touch('nws-radar-conus');
      await new Promise((r) => setImmediate(r));
      assert.strictEqual(fetches, 1);
      clock += 60000;
      p.touch('nws-radar-conus');
      assert.strictEqual(fetches, 1, 'a fresh timeline is not re-read');
      clock += 300000;
      p.touch('nws-radar-conus');
      assert.strictEqual(fetches, 2);
    } finally {
      p.stop();
    }
  });

  it('shares one download between entries on the same capabilities URL', async () => {
    let fetches = 0;
    const p = poller(() => {
      fetches++;
      return Promise.resolve(NCEP_WMS);
    });
    const twin = { ...target, catalogId: 'twin' };
    try {
      p.sync([target, twin]);
      await Promise.all([p.poll(target), p.poll(twin)]);
      assert.strictEqual(fetches, 1);
      assert.ok(p.get('twin'));
    } finally {
      p.stop();
    }
  });

  it('keeps the last timeline through a failed download, withdraws it when the layer loses it', async () => {
    const changes: string[] = [];
    let mode: 'ok' | 'fail' | 'gone' = 'ok';
    let clock = NOW;
    const p = poller(
      () =>
        mode === 'fail'
          ? Promise.reject(new Error('offline'))
          : Promise.resolve(mode === 'ok' ? NCEP_WMS : '<WMS_Capabilities/>'),
      changes,
      () => clock
    );
    try {
      p.sync([target]);
      await p.poll(target);
      mode = 'fail';
      clock += 120000;
      await p.poll(target);
      assert.ok(p.get('nws-radar-conus'));
      mode = 'gone';
      clock += 120000;
      await p.poll(target);
      assert.strictEqual(p.get('nws-radar-conus'), undefined);
      assert.strictEqual(changes.at(-1), 'nws-radar-conus withdrawn');
    } finally {
      p.stop();
    }
  });

  it('discards a result that arrives after its target was replaced', async () => {
    const changes: string[] = [];
    let release: (xml: string) => void = () => {};
    const p = poller(() => new Promise<string>((r) => (release = r)), changes);
    try {
      p.sync([target]);
      const pending = p.poll(target);
      p.sync([{ ...target, window: { kind: 'observation', window: 'PT1H' } }]);
      release(NCEP_WMS);
      await pending;
      assert.deepStrictEqual(changes, []);
    } finally {
      p.stop();
    }
  });

  it('forgets entries it no longer tracks', async () => {
    const p = poller(() => Promise.resolve(NCEP_WMS));
    p.sync([target]);
    await p.poll(target);
    p.sync([]);
    assert.strictEqual(p.get('nws-radar-conus'), undefined);
    p.stop();
  });
});
