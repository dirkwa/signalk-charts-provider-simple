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
