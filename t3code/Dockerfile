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

# Libraries + fonts for T3's headless browser (preview tabs, html_preview/render).
# T3 downloads chrome-headless-shell into $T3CODE_HOME/tools on first use, but the
# Debian base lacks the shared libraries it links against, so it fails with
# PreviewBrowserLibrariesError. This is the list `t3 browser setup` installs
# (PreviewBrowserHost DEBIAN_PACKAGES, bookworm names) plus fonts so pages don't
# render as tofu. Baked in rather than run at start: setup needs apt + network.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        fonts-dejavu-core \
        fonts-liberation \
        fonts-noto-color-emoji \
        libasound2 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libatspi2.0-0 \
        libdbus-1-3 \
        libexpat1 \
        libgbm1 \
        libglib2.0-0 \
        libnss3 \
        libx11-6 \
        libxcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxext6 \
        libxfixes3 \
        libxkbcommon0 \
        libxrandr2 \
    && rm -rf /var/lib/apt/lists/*

# Node is still required — but only for the Claude Code CLI, the ingress proxy
# (proxy.mjs) and persistent_npm_packages.
# Debian bookworm ships Node 18; NodeSource 22.x keeps us at the version the
# Alpine base used to provide (22.23+) and satisfies Claude Code's engine floor.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# T3 Code version. Pinned (rather than @latest) for reproducible builds.
# Bump this one line to update T3.
ARG T3_VERSION=0.1.5

# Reduce npm flakiness.
ENV npm_config_audit=false npm_config_fund=false npm_config_fetch_retries=5

# Since T3 0.1.1 the `t3` npm package is a pure-JS launcher with no platform
# dependency: on first run it downloads t3-<ver>-<platform>.tar.gz from the GitHub
# Release into $T3CODE_HOME/runtime/versions/<ver>. Here T3CODE_HOME is /data/t3code,
# so that would be a ~300 MB download at first boot of every version, piling up
# old versions inside /data (and HA backups). Instead the same release archive is
# baked into the image: fetched at build time, checked against the release's
# SHA256SUMS (as the launcher does), unpacked self-contained (binary + client +
# node_modules) to /usr/local/lib/t3code, and the binary symlinked onto PATH.
# The executable resolves its assets from its real path, so the symlink is fine.
RUN NODE_ARCH="$(node -e 'console.log(process.arch)')" \
    && ARCHIVE="t3-${T3_VERSION}-linux-${NODE_ARCH}.tar.gz" \
    && RELEASE="https://github.com/pingdotgg/t3code/releases/download/v${T3_VERSION}" \
    && cd /tmp \
    && curl -fsSL --retry 5 -o "${ARCHIVE}" "${RELEASE}/${ARCHIVE}" \
    && curl -fsSL --retry 5 -o SHA256SUMS "${RELEASE}/SHA256SUMS" \
    && grep -E "^[0-9a-f]{64}  ${ARCHIVE}\$" SHA256SUMS | sha256sum -c - \
    && mkdir -p /usr/local/lib/t3code \
    && tar -xzf "${ARCHIVE}" -C /usr/local/lib/t3code --strip-components=1 --no-same-owner \
    && ln -sf /usr/local/lib/t3code/t3 /usr/local/bin/t3 \
    && rm -f "${ARCHIVE}" SHA256SUMS \
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
