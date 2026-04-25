# Running Signal K (and this plugin) in Docker

The plugin runs OCI containers to convert charts (S-57 ENC → vector MBTiles, BSB → raster MBTiles, basemaps). When Signal K itself runs inside a container, the conversions run in **sibling containers on the host** — the in-container plugin talks to the host's Docker (or Podman) daemon over a mounted socket. There's no need to install a container engine inside the Signal K container.

This page covers the two common shapes:
- Signal K in Docker on a Docker host (most users).
- Signal K in Docker on a Podman host (the [issue #7](https://github.com/dirkwa/signalk-charts-provider-simple/issues/7) setup).

The bare-metal case (Signal K running directly on the host) is unchanged from previous releases — see the [README](../README.md#optional-podman-for-chart-conversion) for the bare-metal install steps.

## How the plugin finds the daemon

At startup, the plugin tries these socket paths in order and uses the first one that responds:

1. `DOCKER_HOST` env var, if set (parses `unix://` and `tcp://` schemes).
2. `/var/run/docker.sock` (default Docker location, also where rootful Podman puts its docker-compat socket).
3. `/run/user/$UID/podman/podman.sock` (rootless Podman).
4. `/run/podman/podman.sock` (rootful Podman as a system service).

If none respond, the plugin's startup log says so and the Convert / Catalog tabs show a warning. The plugin does **not** crash Signal K when no runtime is reachable — chart conversion just stays disabled.

## Docker host, Signal K in Docker

```yaml
services:
  signalk:
    image: signalk/signalk-server:latest
    volumes:
      - ./signalk:/home/node/.signalk
      # Mount the host's Docker socket so the plugin can launch sibling containers.
      - /var/run/docker.sock:/var/run/docker.sock
    group_add:
      # GID of the `docker` group on the *host*, so the in-container `node`
      # user can read the bind-mounted socket. Find it with:
      #   getent group docker | cut -d: -f3
      - "999"
    ports:
      - "3000:3000"
```

Verify after `docker compose up -d`:

```bash
docker compose exec -u node signalk \
  curl -fsS --unix-socket /var/run/docker.sock http://d/_ping
# expects: OK
```

If this returns `permission denied`, your `group_add` GID doesn't match the host's `docker` group. Adjust and recreate the container.

## Podman host, Signal K in Docker

This is GraffJosh's setup. The host runs Podman; Signal K still runs under Docker (or another container engine) but talks to the Podman socket. Podman serves a Docker-compatible API on its own socket, so the plugin code path is identical.

Make sure the rootless Podman socket is up on the host:

```bash
systemctl --user enable --now podman.socket
loginctl enable-linger "$USER"   # so it survives logout
```

The socket path is `/run/user/$(id -u)/podman/podman.sock` — typically `/run/user/1000/podman/podman.sock`.

Then in `docker-compose.yml`:

```yaml
services:
  signalk:
    image: signalk/signalk-server:latest
    environment:
      # Tell the plugin which socket to dial. The container side of the bind mount
      # is fixed to /run/podman/podman.sock for clarity.
      - DOCKER_HOST=unix:///run/podman/podman.sock
    volumes:
      - ./signalk:/home/node/.signalk
      - /run/user/1000/podman/podman.sock:/run/podman/podman.sock
    ports:
      - "3000:3000"
```

You may need to relax permissions on the host socket so the in-container `node` user (uid 1000 by default) can talk to it:

```bash
chmod 666 /run/user/1000/podman/podman.sock
# Or, more conservatively, ACL the user that's running Docker:
setfacl -m u:1000:rw /run/user/1000/podman/podman.sock
```

The reason: under rootful Docker, host UIDs don't map cleanly into the container, so the bind-mounted socket appears with surprising ownership inside the container. ACLs / `chmod 666` are the simplest workarounds. If you're using rootless Docker (or running Signal K under Podman directly), UIDs map and no permission tweak is needed.

Verify:

```bash
docker compose exec -u node signalk \
  curl -fsS --unix-socket /run/podman/podman.sock http://d/_ping
# expects: OK
```

## Common pitfalls

- **`DOCKER_HOST` vs `CONTAINER_HOST`** — the plugin reads `DOCKER_HOST`. Setting only `CONTAINER_HOST` (Podman's native variable) does nothing here.
- **Stale value in `DOCKER_HOST`** — if you set it to a path that doesn't exist, the plugin will fall through to the standard fallbacks. The startup log shows which socket it actually picked.
- **`privileged: true`** — not required, even for the Podman-host case. Mounting the socket is enough.
- **SELinux** — on Fedora/RHEL/CentOS hosts, you may need `:Z` on the bind mounts (host side, on the daemon's bind, not the plugin's container args). The plugin's own bind syntax doesn't pass `:Z` since Docker doesn't accept it.
- **Network isolation** — chart-conversion containers are short-lived and don't expose ports. They share whatever network the host daemon defaults to (usually `bridge`); no extra config needed.

## What about plain Podman directly?

If you run Signal K **directly on the host** (no Docker / Compose involved) and have Podman installed, do nothing — `systemctl --user enable --now podman.socket` is enough. The plugin defaults to dialing the rootless Podman socket and works as before.

## See also

- [Issue #7](https://github.com/dirkwa/signalk-charts-provider-simple/issues/7) — the original report that prompted this doc.
- [Docker reference: bind mounts](https://docs.docker.com/storage/bind-mounts/)
- [Podman: Docker-compatible API](https://docs.podman.io/en/latest/markdown/podman-system-service.1.html)
