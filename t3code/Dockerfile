ARG BUILD_FROM
FROM ${BUILD_FROM}

# Runtime packages. nodejs on Alpine 3.21 is 22.23+, which satisfies t3's
# engine floor (^22.16 || >=24.10). git is needed because T3 drives real repos;
# libstdc++ is the runtime lib for node-pty's compiled native addon.
RUN apk add --no-cache \
    bash \
    curl \
    git \
    jq \
    libstdc++ \
    nodejs \
    npm \
    openssh-client \
    tini

# T3 Code version. Pinned (rather than @latest) for reproducible builds: T3's
# dependency tree is huge (Clerk/Coinbase SDKs) and @latest resolution has proven
# non-deterministic on Alpine npm. Bump this one line to update T3.
ARG T3_VERSION=0.0.36

# Reduce npm flakiness on the large tree.
ENV npm_config_audit=false npm_config_fund=false npm_config_fetch_retries=5

# Build toolchain for node-pty's native addon (compiled against musl), then
# removed to keep the image lean — the compiled .node artifact stays behind.
# Installs are split so a failure points at the right package.
RUN apk add --no-cache --virtual .build-deps build-base python3 \
    && npm install -g --unsafe-perm "t3@${T3_VERSION}" \
    && npm install -g --unsafe-perm @anthropic-ai/claude-code@latest \
    # T3's ffi-rs native dep ships per-platform bindings as OPTIONAL deps; npm on
    # musl does not install the musl one. We can't run `npm install` inside t3's
    # dir to add it — t3's package.json has `overrides` with nested-key syntax
    # (e.g. "@clerk/clerk-js>@base-org/account") that Alpine's npm 10.x rejects
    # with EINVALIDPACKAGENAME. So fetch the binding as a plain tarball via
    # `npm pack` (no overrides processing) and drop it where ffi-rs resolves it.
    && T3_NM="$(npm root -g)/t3" \
    && FFI_VER="$(node -e "console.log(require('${T3_NM}/node_modules/ffi-rs/package.json').version)")" \
    && NODE_ARCH="$(node -e "console.log(process.arch)")" \
    && FFI_PKG="ffi-rs-linux-${NODE_ARCH}-musl" \
    && mkdir -p "${T3_NM}/node_modules/@yuuang" /tmp/ffi \
    && ( cd /tmp/ffi && npm pack "@yuuang/${FFI_PKG}@${FFI_VER}" \
         && tar -xzf yuuang-${FFI_PKG}-*.tgz \
         && rm -rf "${T3_NM}/node_modules/@yuuang/${FFI_PKG}" \
         && mv package "${T3_NM}/node_modules/@yuuang/${FFI_PKG}" ) \
    && rm -rf /tmp/ffi \
    && npm cache clean --force \
    && apk del .build-deps

# Sanity: both CLIs must be runnable in the image (hard-fails the build otherwise).
RUN t3 --version && claude --version

# Tailscale (userspace-networking mode — no TUN/NET_ADMIN needed) for the optional
# tailnet-only access path: `tailscale serve` exposes the T3 server on the tailnet
# with T3's native pairing, coexisting with HA ingress. Late layer to preserve the
# npm build cache. Gated on the tailscale_authkey option in run.sh.
RUN apk add --no-cache tailscale

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
