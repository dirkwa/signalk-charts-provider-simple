/**
 * Pixel work for filling missing raster tiles: decode the stored neighbours,
 * resample them into the requested tile and encode the result. Runs in the
 * raster worker pool (raster-worker-pool.ts) so the CPU time stays off the
 * server's event loop.
 */

import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

const JPEG_QUALITY = 85;

export interface RasterTile {
  data: Uint8Array;
  contentType: 'image/png' | 'image/jpeg';
}

/** Stored tiles around a missing one, as read from the MBTiles. */
export interface RasterJob {
  format: string;
  /** Nearest stored ancestor, d levels up; (qx, qy) is the sub-square to stretch. */
  ancestor: { raw: Uint8Array; d: number; qx: number; qy: number } | null;
  /** Stored children one level down, in quadrant (dx, dy). */
  children: { raw: Uint8Array; dx: number; dy: number }[];
}

export interface RasterImage {
  width: number;
  height: number;
  // RGBA, 4 bytes per pixel
  data: Uint8Array;
}

// Sniffed rather than taken from the metadata format: exports labelled jpg
// commonly store PNG tiles where they need transparency.
export function decodeRaster(raw: Uint8Array): RasterImage | null {
  if (raw[0] === 0xff && raw[1] === 0xd8) {
    const img = jpeg.decode(raw, { useTArray: true, formatAsRGBA: true });
    return { width: img.width, height: img.height, data: img.data };
  }
  if (raw[0] === 0x89 && raw[1] === 0x50 && raw[2] === 0x4e && raw[3] === 0x47) {
    const png = PNG.sync.read(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength));
    return { width: png.width, height: png.height, data: png.data };
  }
  return null;
}

/**
 * Bilinear upscale of the (qx, qy) sub-square of `src` at magnification
 * 2^d, filling an image the size of `src`.
 */
function upscaleQuadrant(src: RasterImage, d: number, qx: number, qy: number): RasterImage {
  const { width, height } = src;
  const scale = 1 << d;
  const out = new Uint8Array(width * height * 4);
  for (let j = 0; j < height; j++) {
    const sy = Math.min(Math.max((qy * height + j + 0.5) / scale - 0.5, 0), height - 1);
    const y0 = Math.floor(sy);
    const y1 = Math.min(y0 + 1, height - 1);
    const fy = sy - y0;
    for (let i = 0; i < width; i++) {
      const sx = Math.min(Math.max((qx * width + i + 0.5) / scale - 0.5, 0), width - 1);
      const x0 = Math.floor(sx);
      const x1 = Math.min(x0 + 1, width - 1);
      const fx = sx - x0;
      const p00 = (y0 * width + x0) * 4;
      const p01 = (y0 * width + x1) * 4;
      const p10 = (y1 * width + x0) * 4;
      const p11 = (y1 * width + x1) * 4;
      const o = (j * width + i) * 4;
      for (let c = 0; c < 4; c++) {
        const top = src.data[p00 + c] * (1 - fx) + src.data[p01 + c] * fx;
        const bottom = src.data[p10 + c] * (1 - fx) + src.data[p11 + c] * fx;
        out[o + c] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return { width, height, data: out };
}

/** 2×2 box-downsample `child` into quadrant (dx, dy) of `out`. */
function downsampleInto(out: RasterImage, child: RasterImage, dx: number, dy: number): void {
  const { width, height } = out;
  const halfW = width >> 1;
  const halfH = height >> 1;
  for (let j = 0; j < halfH; j++) {
    for (let i = 0; i < halfW; i++) {
      const c00 = (2 * j * width + 2 * i) * 4;
      const c01 = c00 + 4;
      const c10 = c00 + width * 4;
      const c11 = c10 + 4;
      const o = ((dy * halfH + j) * width + dx * halfW + i) * 4;
      for (let c = 0; c < 4; c++) {
        out.data[o + c] =
          (child.data[c00 + c] +
            child.data[c01 + c] +
            child.data[c10 + c] +
            child.data[c11 + c] +
            2) >>
          2;
      }
    }
  }
}

function isOpaque(img: RasterImage): boolean {
  for (let i = 3; i < img.data.length; i += 4) {
    if (img.data[i] !== 255) {
      return false;
    }
  }
  return true;
}

function encode(img: RasterImage, format: string): RasterTile {
  if (format !== 'png' && isOpaque(img)) {
    const encoded = jpeg.encode(
      { data: img.data, width: img.width, height: img.height },
      JPEG_QUALITY
    );
    return { data: encoded.data, contentType: 'image/jpeg' };
  }
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  return { data: PNG.sync.write(png), contentType: 'image/png' };
}

/**
 * The missing tile: the ancestor upscaled as background, overlaid with the
 * downsampled children. Null when none of the stored tiles decodes (webp, or
 * corrupt data).
 */
export function composeRasterTile(job: RasterJob): RasterTile | null {
  const children: { img: RasterImage; dx: number; dy: number }[] = [];
  for (const { raw, dx, dy } of job.children) {
    const img = decodeRaster(raw);
    if (img) {
      children.push({ img, dx, dy });
    }
  }

  let out: RasterImage | null = null;
  if (job.ancestor && children.length < 4) {
    const img = decodeRaster(job.ancestor.raw);
    if (img) {
      out = upscaleQuadrant(img, job.ancestor.d, job.ancestor.qx, job.ancestor.qy);
    }
  }

  for (const { img, dx, dy } of children) {
    if (!out) {
      out = { width: img.width, height: img.height, data: new Uint8Array(img.data.length) };
    }
    if (img.width === out.width && img.height === out.height) {
      downsampleInto(out, img, dx, dy);
    }
  }

  return out ? encode(out, job.format) : null;
}
