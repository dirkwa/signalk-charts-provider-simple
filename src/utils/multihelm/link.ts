/**
 * Registers this plugin's datasets with signalk-multihelm while it runs.
 *
 * Multihelm publishes its API as the PropertyValue `multihelm` from its
 * start, and `{ apiVersion: 1 }` without methods after its stop; the last
 * value is what holds. Every time the methods appear (Multihelm started or
 * restarted) the datasets are registered again.
 */

import {
  MULTIHELM_PROPERTY,
  isMultihelmProperty,
  type DatasetDefinition,
  type DatasetHandle
} from './api.js';

export interface PropertyValueSource {
  onPropertyValues: (
    name: string,
    cb: (values: ({ value: unknown } | undefined)[]) => void
  ) => () => void;
}

export interface MultihelmLink {
  /** Something changed here: Multihelm looks sooner than its next round. */
  changed: () => void;
  /** Whether the datasets are registered now. */
  connected: () => boolean;
  /** Withdraws the datasets and stops following Multihelm. */
  stop: () => void;
}

/**
 * Follows Multihelm's PropertyValue and registers the datasets with each
 * Multihelm that appears, withdrawing them when it stops.
 */
export function linkMultihelm(
  app: PropertyValueSource,
  datasets: () => DatasetDefinition[],
  log: { debug: (msg: string) => void; error: (msg: string) => void }
): MultihelmLink {
  let handles: DatasetHandle[] = [];
  let registerOf: unknown = null;

  const release = (): void => {
    for (const handle of handles) {
      handle.unregister();
    }
    handles = [];
    registerOf = null;
  };

  const unsubscribe = app.onPropertyValues(MULTIHELM_PROPERTY, (values) => {
    const value = values.at(-1)?.value;
    const register = isMultihelmProperty(value) ? value.registerDataset : undefined;
    if (register === registerOf) {
      return;
    }
    release();
    if (typeof register !== 'function') {
      return;
    }
    try {
      // Each handle is kept as soon as it exists, so a later failure still releases it.
      for (const definition of datasets()) {
        handles.push(register(definition));
      }
      registerOf = register;
      log.debug('Multihelm: chart datasets registered');
    } catch (error) {
      release();
      log.error(
        `Multihelm: cannot register the chart datasets: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  return {
    changed: () => {
      for (const handle of handles) {
        handle.changed();
      }
    },
    connected: () => handles.length > 0,
    stop: () => {
      unsubscribe();
      release();
    }
  };
}
