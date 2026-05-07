import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Type } from '@sinclair/typebox';

import { parseBody, parseShape } from '../dist/utils/rest-validation.js';

interface FakeRes {
  statusCode: number;
  body: unknown;
  status(code: number): FakeRes;
  json(payload: unknown): FakeRes;
}

function fakeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
  return res;
}

describe('parseBody', () => {
  const Body = Type.Object({
    url: Type.String({ minLength: 1 }),
    minzoom: Type.Optional(Type.Integer({ minimum: 0, maximum: 22 }))
  });

  it('returns the typed body when valid', () => {
    const res = fakeRes();
    const result = parseBody(
      Body,
      { body: { url: 'http://x', minzoom: 5 } } as never,
      res as never
    );
    assert.deepStrictEqual(result, { url: 'http://x', minzoom: 5 });
    assert.strictEqual(res.statusCode, 200);
  });

  it('returns null and sends 400 when a required field is missing', () => {
    const res = fakeRes();
    const result = parseBody(Body, { body: {} } as never, res as never);
    assert.strictEqual(result, null);
    assert.strictEqual(res.statusCode, 400);
    const payload = res.body as { success: boolean; error: string; details: string[] };
    assert.strictEqual(payload.success, false);
    assert.match(payload.error, /Invalid request body/);
    assert.ok(payload.details.some((d) => /url/.test(d)));
  });

  it('rejects an out-of-range zoom level', () => {
    const res = fakeRes();
    const result = parseBody(
      Body,
      { body: { url: 'http://x', minzoom: 99 } } as never,
      res as never
    );
    assert.strictEqual(result, null);
    assert.strictEqual(res.statusCode, 400);
    const payload = res.body as { details: string[] };
    assert.ok(payload.details.some((d) => /minzoom/.test(d)));
  });

  it('rejects a non-integer zoom level', () => {
    const res = fakeRes();
    const result = parseBody(
      Body,
      { body: { url: 'http://x', minzoom: 5.5 } } as never,
      res as never
    );
    assert.strictEqual(result, null);
    assert.strictEqual(res.statusCode, 400);
  });

  it('caps the details list at five entries even with more failures', () => {
    const Big = Type.Object({
      a: Type.String(),
      b: Type.String(),
      c: Type.String(),
      d: Type.String(),
      e: Type.String(),
      f: Type.String(),
      g: Type.String()
    });
    const res = fakeRes();
    parseBody(Big, { body: {} } as never, res as never);
    const payload = res.body as { details: string[] };
    assert.ok(payload.details.length <= 5);
  });
});

describe('parseShape', () => {
  // Mirrors the busboy/header use case: every input arrives as a string
  // (or is undefined). parseShape uses Value.Convert so numeric schemas
  // accept stringified numbers.
  const Fields = Type.Object({
    type: Type.Union([Type.Literal('s57'), Type.Literal('rnc')]),
    minzoom: Type.Optional(Type.Integer({ minimum: 0, maximum: 22 })),
    maxzoom: Type.Optional(Type.Integer({ minimum: 0, maximum: 22 }))
  });

  it('returns the typed shape with numeric coercion from strings', () => {
    const res = fakeRes();
    const result = parseShape(Fields, { type: 's57', minzoom: '9', maxzoom: '16' }, res as never);
    assert.deepStrictEqual(result, { type: 's57', minzoom: 9, maxzoom: 16 });
    assert.strictEqual(res.statusCode, 200);
  });

  it('rejects an unknown literal value', () => {
    const res = fakeRes();
    const result = parseShape(Fields, { type: 'turbo' }, res as never);
    assert.strictEqual(result, null);
    assert.strictEqual(res.statusCode, 400);
    const payload = res.body as { details: string[] };
    assert.ok(payload.details.some((d) => /type/.test(d)));
  });

  it('rejects a stringified integer that is out of range', () => {
    const res = fakeRes();
    const result = parseShape(Fields, { type: 's57', minzoom: '99' }, res as never);
    assert.strictEqual(result, null);
    assert.strictEqual(res.statusCode, 400);
  });

  it('rejects when a required header is missing', () => {
    const Headers = Type.Object({
      'x-upload-filename': Type.String({ minLength: 1, pattern: '\\.mbtiles$' }),
      'x-chunk-index': Type.Integer({ minimum: 0 })
    });
    const res = fakeRes();
    const result = parseShape(
      Headers,
      { 'x-upload-filename': undefined, 'x-chunk-index': '0' },
      res as never
    );
    assert.strictEqual(result, null);
    assert.strictEqual(res.statusCode, 400);
  });

  it('rejects a filename without the .mbtiles suffix', () => {
    const Headers = Type.Object({
      'x-upload-filename': Type.String({ minLength: 1, pattern: '\\.mbtiles$' })
    });
    const res = fakeRes();
    const result = parseShape(Headers, { 'x-upload-filename': 'evil.exe' }, res as never);
    assert.strictEqual(result, null);
    assert.strictEqual(res.statusCode, 400);
  });
});
