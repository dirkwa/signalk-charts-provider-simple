/**
 * Small stand-ins for the OSM land polygon downloads: a shapefile written
 * from rings, and a zip holding it, so the land index can be built from
 * bytes the tests control.
 */

import zlib from 'node:zlib';

/** A ring as [x, y] pairs in Web Mercator metres. */
export type TestRing = [number, number][];

/** An ESRI `.shp` of Polygon records (a null shape for an empty polygon). */
export function shapefile(polygons: TestRing[][]): Buffer {
  const records = polygons.map((rings, i) => {
    if (rings.length === 0) {
      const content = Buffer.alloc(4);
      content.writeInt32LE(0, 0);
      return { number: i + 1, content };
    }
    const points = rings.flat();
    const content = Buffer.alloc(44 + 4 * rings.length + 16 * points.length);
    content.writeInt32LE(5, 0);
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    content.writeDoubleLE(Math.min(...xs), 4);
    content.writeDoubleLE(Math.min(...ys), 12);
    content.writeDoubleLE(Math.max(...xs), 20);
    content.writeDoubleLE(Math.max(...ys), 28);
    content.writeInt32LE(rings.length, 36);
    content.writeInt32LE(points.length, 40);
    let start = 0;
    rings.forEach((ring, r) => {
      content.writeInt32LE(start, 44 + 4 * r);
      start += ring.length;
    });
    const at = 44 + 4 * rings.length;
    points.forEach(([x, y], p) => {
      content.writeDoubleLE(x, at + 16 * p);
      content.writeDoubleLE(y, at + 16 * p + 8);
    });
    return { number: i + 1, content };
  });
  const header = Buffer.alloc(100);
  header.writeInt32BE(9994, 0);
  header.writeInt32LE(1000, 28);
  header.writeInt32LE(5, 32);
  const body = records.map(({ number, content }) => {
    const recordHeader = Buffer.alloc(8);
    recordHeader.writeInt32BE(number, 0);
    recordHeader.writeInt32BE(content.length / 2, 4);
    return Buffer.concat([recordHeader, content]);
  });
  const file = Buffer.concat([header, ...body]);
  file.writeInt32BE(file.length / 2, 24);
  return file;
}

/** A zip of uncompressed entries. */
export function storedZip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, 'utf-8');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, end]);
}

/** A zip like OSM's: the shapefile beside the parts the index does not read. */
export function landZip(folder: string, polygons: TestRing[][]): Buffer {
  return storedZip([
    { name: `${folder}/README.txt`, data: Buffer.from('test land polygons') },
    { name: `${folder}/land_polygons.shp`, data: shapefile(polygons) },
    { name: `${folder}/land_polygons.dbf`, data: Buffer.alloc(32) }
  ]);
}

/** An axis-aligned rectangle as a closed ring, clockwise as shapefile outer rings are. */
export function rect(minX: number, minY: number, maxX: number, maxY: number): TestRing {
  return [
    [minX, minY],
    [minX, maxY],
    [maxX, maxY],
    [maxX, minY],
    [minX, minY]
  ];
}
