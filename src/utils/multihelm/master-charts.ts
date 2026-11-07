/**
 * On a server that is not the boat's master, serves the master's charts
 * next to its own, without a copy: the chart list is read from the master
 * through Multihelm, and tile URLs point at Multihelm's proxy on this
 * server, so a browser here never talks to the master itself.
 */

import type { SanitizedChart } from '../../types.js';
import {
  MULTIHELM_PROPERTY,
  isMultihelmProperty,
  type MasterRouteHandle,
  type MultihelmProperty
} from './api.js';
import type { PropertyValueSource } from './link.js';

export const MASTER_CHARTS_LIST = '/signalk/v2/api/resources/charts';
export const MASTER_TILES_PREFIX = '/signalk/v1/api/resources/charts/';
export const MASTER_POLL_MS = 60_000;

type MasterApi = MultihelmProperty &
  Required<
    Pick<
      MultihelmProperty,
      'role' | 'master' | 'onRoleChanged' | 'registerMasterRoute' | 'masterPath' | 'fetchMaster'
    >
  >;

function hasMasterRoutes(value: MultihelmProperty): value is MasterApi {
  return (
    typeof value.role === 'function' &&
    typeof value.master === 'function' &&
    typeof value.onRoleChanged === 'function' &&
    typeof value.registerMasterRoute === 'function' &&
    typeof value.masterPath === 'function' &&
    typeof value.fetchMaster === 'function'
  );
}

const ABSOLUTE_URL = /^https?:\/\//i;

/**
 * The master's chart list as this server serves it. Tiles on the master are
 * reached through `masterPath`, online charts stay as they are, and a chart
 * whose tiles are neither is left out.
 */
export function chartsFromMaster(
  list: unknown,
  masterPath: (path: string) => string
): Record<string, SanitizedChart> {
  const charts: Record<string, SanitizedChart> = {};
  if (typeof list !== 'object' || list === null || Array.isArray(list)) {
    return charts;
  }
  for (const [id, raw] of Object.entries(list as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) {
      continue;
    }
    const chart = raw as Record<string, unknown>;
    const url = chart.url;
    if (typeof url !== 'string' || typeof chart.name !== 'string') {
      continue;
    }
    let served: string;
    if (url.startsWith(MASTER_TILES_PREFIX)) {
      served = masterPath(url);
    } else if (ABSOLUTE_URL.test(url)) {
      served = url;
    } else {
      continue;
    }
    charts[id] = { ...chart, identifier: id, url: served } as unknown as SanitizedChart;
  }
  return charts;
}

export class MasterCharts {
  private current: Record<string, SanitizedChart> = {};
  private api: MasterApi | null = null;
  private routes: MasterRouteHandle[] = [];
  private stopRole: (() => void) | null = null;
  private generation = 0;
  private readonly unsubscribe: () => void;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    app: PropertyValueSource,
    private readonly changed: (id: string, chart: SanitizedChart | null) => void,
    private readonly log: { debug: (msg: string) => void; error: (msg: string) => void }
  ) {
    this.unsubscribe = app.onPropertyValues(MULTIHELM_PROPERTY, (values) => {
      const value = values.at(-1)?.value;
      const next = isMultihelmProperty(value) && hasMasterRoutes(value) ? value : null;
      if (next?.fetchMaster === this.api?.fetchMaster) {
        return;
      }
      this.detach();
      if (next) {
        this.attach(next);
      }
    });
    this.timer = setInterval(() => {
      void this.refresh();
    }, MASTER_POLL_MS);
  }

  charts(): Record<string, SanitizedChart> {
    return this.current;
  }

  chart(id: string): SanitizedChart | undefined {
    return Object.hasOwn(this.current, id) ? this.current[id] : undefined;
  }

  async refresh(): Promise<void> {
    const api = this.api;
    if (!api) {
      return;
    }
    const generation = ++this.generation;
    let next: Record<string, SanitizedChart> = {};
    if (api.role() === 'member' && api.master() !== null) {
      try {
        const answer = await api.fetchMaster(MASTER_CHARTS_LIST);
        if (answer.status !== 200) {
          throw new Error(`HTTP ${String(answer.status)}`);
        }
        next = chartsFromMaster(JSON.parse(answer.body.toString('utf-8')), api.masterPath);
      } catch (error) {
        // A master that answers again soon keeps its charts in the list meanwhile.
        this.log.debug(
          `Multihelm: cannot read the master's charts: ${error instanceof Error ? error.message : String(error)}`
        );
        return;
      }
    }
    if (generation === this.generation) {
      this.replace(next);
    }
  }

  stop(): void {
    this.unsubscribe();
    clearInterval(this.timer);
    this.detach();
  }

  private attach(api: MasterApi): void {
    try {
      this.routes.push(api.registerMasterRoute(`${MASTER_CHARTS_LIST}/`));
      this.routes.push(api.registerMasterRoute(MASTER_TILES_PREFIX));
    } catch (error) {
      this.detach();
      this.log.error(
        `Multihelm: cannot serve the master's charts: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
    this.api = api;
    this.stopRole = api.onRoleChanged(() => {
      void this.refresh();
    });
    void this.refresh();
  }

  private detach(): void {
    for (const route of this.routes) {
      route.unregister();
    }
    this.routes = [];
    this.stopRole?.();
    this.stopRole = null;
    this.api = null;
    this.generation++;
    this.replace({});
  }

  private replace(next: Record<string, SanitizedChart>): void {
    const previous = this.current;
    this.current = next;
    for (const id of Object.keys(previous)) {
      if (!Object.hasOwn(next, id)) {
        this.changed(id, null);
      }
    }
    for (const [id, chart] of Object.entries(next)) {
      if (JSON.stringify(previous[id]) !== JSON.stringify(chart)) {
        this.changed(id, chart);
      }
    }
  }
}
