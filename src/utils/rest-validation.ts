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
import type { Request } from '../types';
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
