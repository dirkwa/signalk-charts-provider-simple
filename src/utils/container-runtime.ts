import fs from 'fs';
import { PassThrough } from 'stream';
import Docker from 'dockerode';
import type { ContainerRuntimeStatus } from '../types';

export type RuntimeStatus = ContainerRuntimeStatus;

export interface RunOptions {
  image: string;
  cmd?: string[];
  binds?: string[];
  env?: string[];
  /** Short identifier for the work being done (e.g. 'tippecanoe', 'gdal-export'). Becomes part of the container name and a label. */
  phase?: string;
  /** Identifier of the chart/job being processed. Becomes part of the container name and a label. */
  job?: string;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /** Override the user the container runs as (format: "uid[:gid]" or "user[:group]") */
  user?: string;
}

interface ResolvedClient {
  client: Docker;
  socketPath: string;
}

let cachedClient: ResolvedClient | null = null;
let cachedStatus: RuntimeStatus | null = null;

function candidateSocketPaths(): string[] {
  const list: string[] = [];

  const dockerHost = process.env.DOCKER_HOST?.trim();
  if (dockerHost) {
    if (dockerHost.startsWith('unix://')) {
      list.push(dockerHost.slice('unix://'.length));
    }
  }

  list.push('/var/run/docker.sock');

  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid !== null) {
    list.push(`/run/user/${uid}/podman/podman.sock`);
  }

  list.push('/run/podman/podman.sock');

  return list;
}

async function probeSocket(socketPath: string): Promise<Docker | null> {
  if (!fs.existsSync(socketPath)) {
    return null;
  }
  const client = new Docker({ socketPath });
  try {
    await client.ping();
    return client;
  } catch {
    return null;
  }
}

async function resolveClient(): Promise<ResolvedClient | null> {
  if (cachedClient) {
    return cachedClient;
  }
  const seen = new Set<string>();
  for (const candidate of candidateSocketPaths()) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    const client = await probeSocket(candidate);
    if (client) {
      cachedClient = { client, socketPath: candidate };
      return cachedClient;
    }
  }
  return null;
}

function detectEngine(version: Docker.DockerVersion): 'docker' | 'podman' {
  const components = (version as { Components?: Array<{ Name?: string }> }).Components ?? [];
  for (const c of components) {
    if (c?.Name && /podman/i.test(c.Name)) {
      return 'podman';
    }
  }
  return 'docker';
}

export async function checkContainerRuntime(): Promise<RuntimeStatus> {
  if (cachedStatus) {
    return cachedStatus;
  }
  const resolved = await resolveClient();
  if (!resolved) {
    return { available: false, version: null, socketPath: null, engine: null };
  }
  try {
    const version = await resolved.client.version();
    const engine = detectEngine(version);
    cachedStatus = {
      available: true,
      version: `${engine === 'podman' ? 'podman' : 'docker'} version ${version.Version}`,
      socketPath: resolved.socketPath,
      engine
    };
    return cachedStatus;
  } catch {
    return {
      available: false,
      version: null,
      socketPath: resolved.socketPath,
      engine: null
    };
  }
}

export async function imageExists(image: string): Promise<boolean> {
  const resolved = await resolveClient();
  if (!resolved) {
    return false;
  }
  try {
    await resolved.client.getImage(image).inspect();
    return true;
  } catch {
    return false;
  }
}

export async function pullImage(image: string, onProgress?: (msg: string) => void): Promise<void> {
  const resolved = await resolveClient();
  if (!resolved) {
    throw new Error('No container runtime socket available.');
  }
  const stream = await resolved.client.pull(image);
  await new Promise<void>((resolve, reject) => {
    resolved.client.modem.followProgress(
      stream,
      (err: Error | null) => (err ? reject(err) : resolve()),
      (event: { status?: string; progress?: string; id?: string }) => {
        if (onProgress && event?.status) {
          const id = event.id ? ` ${event.id}` : '';
          const detail = event.progress ? ` ${event.progress}` : '';
          onProgress(`${event.status}${id}${detail}`);
        }
      }
    );
  });
}

function splitLines(callback: ((line: string) => void) | undefined): PassThrough {
  const stream = new PassThrough();
  if (!callback) {
    stream.resume();
    return stream;
  }
  // Treat any of \r\n, \n, or bare \r as a line boundary. Tools like tippecanoe
  // repaint a progress line in place using bare \r — without that split, every
  // update concatenates into a single never-ending "line" and stream consumers
  // see only the first segment.
  let buffer = '';
  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split(/\r\n|\r|\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length) {
        callback(trimmed);
      }
    }
  });
  stream.on('end', () => {
    if (buffer.length) {
      const trimmed = buffer.trim();
      if (trimmed.length) {
        callback(trimmed);
      }
      buffer = '';
    }
  });
  return stream;
}

function stripVolumeFlags(bind: string): string {
  // Drop podman-only :Z (SELinux relabel) suffix; the API doesn't accept it on Docker.
  return bind.replace(/(?::Z|,Z)/g, '');
}

const CONTAINER_NAME_PREFIX = 'signalk-charts';
const LABEL_PLUGIN = 'io.signalk.charts-provider.plugin';
const LABEL_PHASE = 'io.signalk.charts-provider.phase';
const LABEL_JOB = 'io.signalk.charts-provider.job';

function sanitizeNamePart(s: string): string {
  // Container names allow [a-zA-Z0-9][a-zA-Z0-9_.-]*; map the rest to '-'.
  return s.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 60);
}

function buildContainerName(
  phase: string | undefined,
  job: string | undefined
): string | undefined {
  if (!phase && !job) {
    return undefined;
  }
  const parts = [CONTAINER_NAME_PREFIX];
  if (phase) {
    parts.push(sanitizeNamePart(phase));
  }
  if (job) {
    parts.push(sanitizeNamePart(job));
  }
  parts.push(String(Date.now()));
  return parts.join('-');
}

export async function runContainer(opts: RunOptions): Promise<{ exitCode: number }> {
  const resolved = await resolveClient();
  if (!resolved) {
    throw new Error('No container runtime socket available.');
  }

  const stdout = splitLines(opts.onStdoutLine);
  const stderr = splitLines(opts.onStderrLine);

  const labels: Record<string, string> = {
    [LABEL_PLUGIN]: 'signalk-charts-provider-simple'
  };
  if (opts.phase) {
    labels[LABEL_PHASE] = opts.phase;
  }
  if (opts.job) {
    labels[LABEL_JOB] = opts.job;
  }

  const createOptions: Docker.ContainerCreateOptions = {
    // By default, run the container as the current process UID:GID so files
    // created by the container are owned by the invoking user. Without this
    // (default behaviour), rootful Docker / rootful Podman would produce
    // files owned by root on the host, which breaks anything we do
    // afterwards that needs to write — most visibly the post-tippecanoe
    // metadata patch, which fails with "attempt to write a readonly
    // database". Allow this to be overridden via `opts.user` for the rare
    // case where a container needs an explicit user. process.getuid is
    // undefined on Windows; Docker Desktop does its own UID translation
    // there, so we leave User unset.
    User:
      opts.user ??
      (typeof process.getuid === 'function' && typeof process.getgid === 'function'
        ? `${process.getuid()}:${process.getgid()}`
        : undefined),
    name: buildContainerName(opts.phase, opts.job),
    Image: opts.image,
    Cmd: opts.cmd,
    Env: opts.env,
    Labels: labels,
    HostConfig: {
      AutoRemove: true,
      Binds: opts.binds?.map(stripVolumeFlags)
    },
    Tty: false
  };

  const container = await resolved.client.createContainer(createOptions);

  const stream = await container.attach({ stream: true, stdout: true, stderr: true });
  resolved.client.modem.demuxStream(stream, stdout, stderr);
  await container.start();
  const result = (await container.wait()) as { StatusCode: number };
  stdout.end();
  stderr.end();
  return { exitCode: result.StatusCode };
}

export function _resetCacheForTests(): void {
  cachedClient = null;
  cachedStatus = null;
}
