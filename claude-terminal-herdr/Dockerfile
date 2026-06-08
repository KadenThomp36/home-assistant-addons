ARG BUILD_FROM
FROM ${BUILD_FROM}

# Install system packages and development tools
RUN apk add --no-cache \
    bash \
    curl \
    nano \
    nodejs \
    npm \
    python3 \
    py3-pip \
    py3-requests \
    py3-aiohttp \
    py3-yaml \
    py3-beautifulsoup4 \
    git \
    vim \
    wget \
    jq \
    tree \
    tmux \
    coreutils \
    yq

# Install Claude Code CLI via npm (avoids musl binary compatibility issues)
RUN npm install -g @anthropic-ai/claude-code@latest \
    && npm cache clean --force

# Install uv for running ha-mcp (Python package manager/runner)
# ha-mcp requires Python 3.13+, uv handles this automatically
RUN apk add --no-cache uv

# Create directory for Claude configuration and set working directory
RUN mkdir -p /config/claude-config
WORKDIR /config

# Install herdr (statically-linked, vendored amd64 binary) as the terminal multiplexer
COPY herdr /usr/local/bin/herdr
RUN chmod +x /usr/local/bin/herdr

# Default herdr config (seeded to the persistent /data location on first run by run.sh)
RUN mkdir -p /opt/herdr
COPY config.toml /opt/herdr/config.toml

# Claude Code statusline (installed to ~/.claude on every start by run.sh)
COPY statusline/ /opt/statusline/
RUN chmod +x /opt/statusline/*.sh

# Bundled Claude skills (installed to ~/.claude/skills on every start by run.sh)
COPY skills/ /opt/skills/
RUN find /opt/skills -name '*.sh' -exec chmod +x {} \;

# Copy startup script and modular scripts
COPY run.sh /run.sh
COPY scripts/ /opt/scripts/
RUN chmod +x /run.sh \
    && chmod +x /opt/scripts/*.sh

# Use exec form for better signal handling
CMD ["/run.sh"]