ARG BUILD_FROM
FROM ${BUILD_FROM}

# ---------------------------------------------------------------------------
# Debian (glibc) base — REQUIRED as of T3 0.0.42.
#
# T3 no longer ships its application through npm. The `t3` package is now a
# ~3 KB shim whose only job is to spawn a self-contained executable delivered as
# the optional dependency @t3code/t3-<platform>-<arch>. That executable is
# dynamically linked against glibc (interpreter /lib64/ld-linux-x86-64.so.2;
# NEEDED libc.so.6, libstdc++.so.6, libgcc_s.so.1, libatomic.so.1) and upstream
# publishes no musl build, so it cannot run on the Alpine base this add-on used
# through 0.4.7.
#
# Upside: the platform package ships every native artifact prebuilt
# (node-pty's build/Release/pty.node, ffi-rs, msgpackr-extract), so the musl
# ffi-rs workaround and the build-base/python3 toolchain that existed only to
# compile node's native addons are both gone.
# ---------------------------------------------------------------------------
ENV DEBIAN_FRONTEND=noninteractive

# Runtime packages. git is needed because T3 drives real repos; the lib* packages
# are what the self-contained T3 executable links against.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        git \
        gnupg \
        jq \
        libatomic1 \
        libgcc-s1 \
        libstdc++6 \
        openssh-client \
        tini \
    && rm -rf /var/lib/apt/lists/*

# Node is still required — but only for the `t3` shim (#!/usr/bin/env node), the
# Claude Code CLI, the ingress proxy (proxy.mjs) and persistent_npm_packages.
# Debian bookworm ships Node 18; NodeSource 22.x keeps us at the version the
# Alpine base used to provide (22.23+) and satisfies Claude Code's engine floor.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# T3 Code version. Pinned (rather than @latest) for reproducible builds.
# Bump this one line to update T3.
ARG T3_VERSION=0.0.42

# Reduce npm flakiness.
ENV npm_config_audit=false npm_config_fund=false npm_config_fetch_retries=5

# The `t3` package is only the launcher shim; the actual executable lives in
# @t3code/t3-linux-<arch>. npm does NOT pull that optional dependency on a global
# install (verified on npm 10.9.8, with and without --include=optional — it
# reports "added 1 package" and `t3 --version` then fails with "no T3 Code CLI
# build is available for this platform"), so it is installed explicitly.
#
# --ignore-scripts is required here, not an optimisation: that package's node-pty
# runs `node scripts/prebuild.js || node-gyp rebuild`, which looks for
# prebuilds/linux-<arch>, does not find it, and falls back to a node-gyp build
# needing a toolchain we deliberately no longer ship. The compiled artifact is
# already in the tarball at node_modules/node-pty/build/Release/pty.node —
# confirmed present for BOTH linux-x64 and linux-arm64 — so that rebuild is
# redundant. Claude Code is installed separately, with its scripts intact.
RUN NODE_ARCH="$(node -e 'console.log(process.arch)')" \
    && npm install -g --unsafe-perm --ignore-scripts \
        "t3@${T3_VERSION}" "@t3code/t3-linux-${NODE_ARCH}@${T3_VERSION}" \
    && npm install -g --unsafe-perm @anthropic-ai/claude-code@latest \
    && npm cache clean --force

# Sanity: both CLIs must be runnable in the image (hard-fails the build otherwise).
# For t3 this also proves the glibc executable actually launches on this base.
RUN t3 --version && claude --version

# Tailscale (userspace-networking mode — no TUN/NET_ADMIN needed) for the optional
# tailnet-only access path: `tailscale serve` exposes the T3 server on the tailnet
# with T3's native pairing, coexisting with HA ingress. Late layer to preserve the
# npm build cache. Gated on the tailscale_authkey option in run.sh.
RUN curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.noarmor.gpg \
        -o /usr/share/keyrings/tailscale-archive-keyring.gpg \
    && curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.tailscale-keyring.list \
        -o /etc/apt/sources.list.d/tailscale.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends tailscale \
    && rm -rf /var/lib/apt/lists/*

# Default T3 settings shipped with the add-on: forces the Claude provider and a
# Claude text-generation model so threads + auto-titles never hit `spawn codex ENOENT`
# or the red "Runtime error". Seeded into the persistent T3CODE_HOME on first run.
COPY rootfs/default-settings.json /opt/t3code/default-settings.json

# In-container reverse proxy: sits between HA ingress and `t3 serve`, injects the
# T3 session cookie (so the HA-authenticated user is transparently authorized) and
# rewrites index.html asset paths for the ingress sub-path.
COPY rootfs/proxy.mjs /opt/t3code/proxy.mjs

# Bundled Claude skills (e.g. spawn-project-t3), installed to ~/.claude/skills on
# every start by run.sh. Late layer to preserve the npm build cache.
COPY skills/ /opt/t3code/skills/
RUN find /opt/t3code/skills -name '*.sh' -exec chmod +x {} \;

# Startup script. No custom ENTRYPOINT: the HA base image's s6-overlay `/init`
# must stay the entrypoint (config.yaml has init:false) so that `with-contenv`
# and bashio in run.sh get the s6 container environment. s6 also reaps children.
COPY run.sh /run.sh
RUN chmod +x /run.sh

CMD ["/run.sh"]
