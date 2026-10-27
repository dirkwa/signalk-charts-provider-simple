// vt-pbf ships no type declarations (and none exist on DefinitelyTyped).
// Only the functions this plugin uses are declared, typed structurally so
// this shim stays decoupled from geojson-vt's and @mapbox/vector-tile's types:
// layer values are geojson-vt tiles for `fromGeojsonVt`, and objects shaped
// like a @mapbox/vector-tile layer for `fromVectorTileJs`.
declare module 'vt-pbf' {
  export function fromGeojsonVt(
    layers: Record<string, { features: unknown[] }>,
    options?: { version?: number; extent?: number }
  ): Uint8Array;

  export function fromVectorTileJs(tile: {
    layers: Record<
      string,
      {
        name: string;
        version: number;
        extent: number;
        length: number;
        feature(i: number): unknown;
      }
    >;
  }): Uint8Array;
}
