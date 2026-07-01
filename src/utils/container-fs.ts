import fs from 'fs';

// The charts-toolbox image runs as `USER toolbox` (UID/GID 1001). Host
// processes create scratch dirs as 0o755 owned by the host UID, which the
// container user cannot write — the root cause of the "/output: Permission
// denied" failures when converting charts in a rootless container.
const TOOLBOX_UID = 1001;

/**
 * Create a scratch directory and make it writable by the toolbox container
 * user. Prefer transferring ownership to UID 1001 (keeps the dir at a
 * least-privilege 0o755); fall back to world-writable 0o777 only when the
 * host process lacks CAP_CHOWN (the common rootless case, where chown EPERMs).
 *
 * Use this for any dir that gets bind-mounted as a writable container mount
 * (`/output`, `/work`, …). Input-only mounts don't need it.
 */
export function makeContainerWritableDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  makeContainerWritable(dir);
  return dir;
}

/**
 * Make an already-created directory writable by the toolbox container user.
 * Same policy as {@link makeContainerWritableDir} for callers that mkdir
 * separately (e.g. with extra options).
 */
export function makeContainerWritable(dir: string): void {
  try {
    fs.chownSync(dir, TOOLBOX_UID, -1);
    fs.chmodSync(dir, 0o755);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') {
      fs.chmodSync(dir, 0o777);
    } else {
      throw err;
    }
  }
}

// Single-quote a string for the shell so paths/flags with spaces or
// metacharacters survive word-splitting intact as one argv element.
export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Wrap a plain-argv container command in a `bash -c` script that runs it and
 * then `chmod 666`s its output file — while the container is still running as
 * the owning UID.
 *
 * `makeContainerWritable` above fixes the *directory* the container writes
 * into, but the toolbox image's tools (tippecanoe, gdaladdo, tile-join,
 * gdal_translate, …) run as the baked-in UID 1001, so the *file* they create
 * lands owned by 1001 with owner-only write (0o644). On deployments without
 * userns keep-id remapping (Docker, rootful podman) the host SignalK process
 * runs as a different UID and can't open that file read-write — the
 * post-conversion metadata patch (patchS57Mbtiles / setMbtilesType /
 * setMbtilesDisplayName) then fails with "attempt to write a readonly
 * database". A host-side chmod can't fix this: the host doesn't own the file.
 * The chmod has to run in-container as the owning UID, which is what this does.
 *
 * `set -e` aborts the script if the wrapped tool fails, so the chmod only runs
 * on success. Callers that tolerate a non-zero exit from the wrapped tool (and
 * still patch the file afterwards) must therefore ensure an *earlier*,
 * mandatory step has already chmod'd the file — see the gdal_translate calls
 * in rnc-converter.ts.
 */
export function withOutputChmod(argv: readonly string[], outputContainerPath: string): string[] {
  const script = [
    'set -e',
    argv.map(shellQuote).join(' '),
    `chmod 666 ${shellQuote(outputContainerPath)}`
  ].join('\n');
  return ['bash', '-c', script];
}
