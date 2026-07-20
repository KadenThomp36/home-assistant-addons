ARG BUILD_FROM
FROM ${BUILD_FROM}

# Runtime packages. nodejs on Alpine 3.21 is 22.23+, which satisfies t3's
# engine floor (^22.16 || >=24.10). git is needed because T3 drives real repos.
RUN apk add --no-cache \
    bash \
    curl \
    git \
    jq \
    nodejs \
    npm \
    openssh-client \
    tini

# Build toolchain for node-pty's native addon (compiled against musl), then
# removed to keep the image lean — the compiled .node artifact stays behind.
RUN apk add --no-cache --virtual .build-deps build-base python3 \
    && npm install -g --unsafe-perm t3@latest @anthropic-ai/claude-code@latest \
    && npm cache clean --force \
    && apk del .build-deps

# Sanity: both CLIs must be runnable in the image (hard-fails the build otherwise).
RUN t3 --version && claude --version

# Default T3 settings shipped with the add-on: forces the Claude provider and a
# Claude text-generation model so threads + auto-titles never hit `spawn codex ENOENT`
# or the red "Runtime error". Seeded into the persistent T3CODE_HOME on first run.
COPY rootfs/default-settings.json /opt/t3code/default-settings.json

# In-container reverse proxy: sits between HA ingress and `t3 serve`, injects the
# T3 session cookie (so the HA-authenticated user is transparently authorized) and
# rewrites index.html asset paths for the ingress sub-path.
COPY rootfs/proxy.mjs /opt/t3code/proxy.mjs

# Startup script
COPY run.sh /run.sh
RUN chmod +x /run.sh

# tini reaps the node children (t3 serve + proxy) cleanly.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/run.sh"]
