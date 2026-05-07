/**
 * Helpers for validating REST request shapes against TypeBox schemas.
 *
 * Each handler that adopts this gets:
 *  - a typed body (no more `as { foo?: string }` casts)
 *  - a single 400 response with a list of which fields failed and why,
 *    instead of one ad-hoc `if (!field)` per field
 *
 * Usage:
 *
 *   const Body = Type.Object({ ... });
 *   const body = parseBody(Body, req, res);
 *   if (!body) return; // 400 already sent
 *   // body is fully typed from here
 */

import type { Response } from 'express';
import type { Request } from '../types.js';
import { Value } from '@sinclair/typebox/value';
import type { TSchema, Static } from '@sinclair/typebox';

function formatErrors(schema: TSchema, input: unknown): string[] {
  return [...Value.Errors(schema, input)]
    .slice(0, 5)
    .map((e) => `${e.path || '<root>'}: ${e.message}`);
}

export function parseBody<T extends TSchema>(
  schema: T,
  req: Request,
  res: Response
): Static<T> | null {
  if (Value.Check(schema, req.body)) {
    return req.body;
  }
  res.status(400).json({
    success: false,
    error: 'Invalid request body',
    details: formatErrors(schema, req.body)
  });
  return null;
}

/**
 * Validate `input` against `schema` and send a single 400 with a
 * field-level error list on failure. Use when the source of fields is
 * something other than `req.body` — busboy field collection, headers,
 * or any other piecemeal-collected map.
 *
 * The input is first run through `Value.Convert`, which coerces
 * compatible primitive types (e.g. the string `"9"` to the number `9`
 * for `Type.Integer`). This matches the way busboy/header handlers
 * receive everything as strings.
 */
export function parseShape<T extends TSchema>(
  schema: T,
  input: unknown,
  res: Response
): Static<T> | null {
  const converted: unknown = Value.Convert(schema, input);
  if (Value.Check(schema, converted)) {
    return converted;
  }
  res.status(400).json({
    success: false,
    error: 'Invalid request fields',
    details: formatErrors(schema, converted)
  });
  return null;
}
