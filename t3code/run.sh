#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
set -e
set -o pipefail

# ---------------------------------------------------------------------------
# Persistent locations (everything under /data survives add-on restarts/updates)
# ---------------------------------------------------------------------------
export HOME="/data/home"                 # persists Claude Code auth at ~/.claude
export T3CODE_HOME="/data/t3code"        # persists projects/threads/auth/settings
export XDG_CONFIG_HOME="/data/.config"
export XDG_CACHE_HOME="/data/.cache"

# T3 drives `claude --dangerously-skip-permissions`; Claude Code refuses that flag
# as root unless IS_SANDBOX=1 (its documented container escape hatch). The add-on
# runs as root inside an isolated container reached only through HA ingress.
export IS_SANDBOX=1

UPSTREAM_PORT=3774                        # loopback t3 serve
PROXY_PORT=3773                           # ingress_port (HA connects here)
BEARER_FILE="${T3CODE_HOME}/.ingress-bearer"
export T3_UPSTREAM_PORT="${UPSTREAM_PORT}"
export T3_PROXY_PORT="${PROXY_PORT}"
export T3_BEARER_FILE="${BEARER_FILE}"

init_dirs() {
    bashio::log.info "Preparing persistent directories under /data..."
    mkdir -p "${HOME}/.claude" "${T3CODE_HOME}/userdata" \
        "${XDG_CONFIG_HOME}" "${XDG_CACHE_HOME}"
    chmod 700 "${HOME}/.claude" 2>/dev/null || true
}

# Seed the shipped default settings.json ONLY on first run. It forces the Claude
# provider + a Claude text-generation model so threads and auto-title/branch-name
# generation never fall back to the (uninstalled) codex model. On later runs the
# user's own GUI edits to settings.json are left untouched.
seed_settings() {
    local target="${T3CODE_HOME}/userdata/settings.json"
    if [ -f "${target}" ]; then
        bashio::log.info "Existing T3 settings.json found — leaving it as-is."
        return
    fi
    local model effort
    model="$(bashio::config 'claude_model' 'claude-opus-4-8')"
    effort="$(bashio::config 'claude_effort' 'high')"
    bashio::log.info "Seeding default T3 settings.json (model=${model}, effort=${effort})..."
    jq --arg m "${model}" --arg e "${effort}" \
        '.textGenerationModelSelection.model=$m
         | .textGenerationModelSelection.options=[{"id":"effort","value":$e}]' \
        /opt/t3code/default-settings.json > "${target}"
}

# Install bundled Claude skills (e.g. spawn-project-t3) into ~/.claude/skills.
# Shipped with the add-on; refreshed on every start (user's own skills untouched).
install_skills() {
    local src="/opt/t3code/skills"
    [ -d "${src}" ] || return
    mkdir -p "${HOME}/.claude/skills"
    # Purge retired bundled skills from the persistent dir (cp never deletes).
    rm -rf "${HOME}/.claude/skills/spawn-project-t3"
    cp -a "${src}/." "${HOME}/.claude/skills/"
    find "${HOME}/.claude/skills" -name '*.sh' -exec chmod +x {} \; 2>/dev/null || true
    bashio::log.info "Bundled Claude skills installed to ~/.claude/skills."
}

install_persistent_packages() {
    local apk_pkgs npm_pkgs
    apk_pkgs="$(bashio::config 'persistent_apk_packages | join(" ")' 2>/dev/null || echo '')"
    npm_pkgs="$(bashio::config 'persistent_npm_packages | join(" ")' 2>/dev/null || echo '')"
    if [ -n "${apk_pkgs}" ] && [ "${apk_pkgs}" != "null" ]; then
        bashio::log.info "Installing persistent apk packages: ${apk_pkgs}"
        # shellcheck disable=SC2086
        apk add --no-cache ${apk_pkgs} || bashio::log.warning "Some apk packages failed."
    fi
    if [ -n "${npm_pkgs}" ] && [ "${npm_pkgs}" != "null" ]; then
        bashio::log.info "Installing persistent npm packages: ${npm_pkgs}"
        # shellcheck disable=SC2086
        npm install -g ${npm_pkgs} || bashio::log.warning "Some npm packages failed."
    fi
}

start_t3() {
    bashio::log.info "Starting T3 Code server on loopback :${UPSTREAM_PORT}..."
    t3 serve \
        --host 127.0.0.1 \
        --port "${UPSTREAM_PORT}" \
        --base-dir "${T3CODE_HOME}" \
        --no-browser &
    T3_PID=$!
}

wait_for_t3() {
    bashio::log.info "Waiting for T3 Code server to come up..."
    for _ in $(seq 1 60); do
        if curl -fsS -o /dev/null "http://127.0.0.1:${UPSTREAM_PORT}/api/auth/session"; then
            bashio::log.info "T3 Code server is up."
            return 0
        fi
        sleep 1
    done
    bashio::log.error "T3 Code server did not become ready in time."
    return 1
}

# Mint a full-scope bearer for the ingress proxy to inject. Revoke any prior
# ha-ingress session first so restarts don't pile up dead sessions.
mint_bearer() {
    bashio::log.info "Minting ingress session token..."
    local sid
    for sid in $(t3 auth session list --base-dir "${T3CODE_HOME}" --json 2>/dev/null \
        | jq -r '.[] | select(.client.label=="ha-ingress") | .sessionId' 2>/dev/null); do
        t3 auth session revoke "${sid}" --base-dir "${T3CODE_HOME}" >/dev/null 2>&1 || true
    done
    local token
    token="$(t3 auth session issue \
        --base-dir "${T3CODE_HOME}" \
        --ttl 3650d \
        --label ha-ingress \
        --json 2>/dev/null | jq -r '.token')"
    if [ -z "${token}" ] || [ "${token}" = "null" ]; then
        bashio::log.error "Failed to mint ingress session token."
        return 1
    fi
    umask 077
    printf '%s' "${token}" > "${BEARER_FILE}"
    bashio::log.info "Ingress session token written to ${BEARER_FILE}."
}

start_proxy() {
    bashio::log.info "Starting ingress proxy on :${PROXY_PORT}..."
    node /opt/t3code/proxy.mjs &
    PROXY_PID=$!
}

# Optional tailnet-only access. When tailscale_authkey is set, join the tailnet in
# userspace-networking mode (no TUN/privileges) and `tailscale serve` the T3 server
# over HTTPS. The tailnet client uses T3's native pairing; the ingress path is
# unaffected (both proxy to the same loopback t3 serve).
start_tailscale() {
    local authkey hostname
    authkey="$(bashio::config 'tailscale_authkey' '')"
    hostname="$(bashio::config 'tailscale_hostname' 't3code-ha')"
    if [ -z "${authkey}" ] || [ "${authkey}" = "null" ]; then
        bashio::log.info "Tailscale disabled (set tailscale_authkey to enable tailnet access)."
        return
    fi
    mkdir -p /data/tailscale /var/run/tailscale
    bashio::log.info "Starting tailscaled (userspace networking)..."
    tailscaled \
        --tun=userspace-networking \
        --state=/data/tailscale/tailscaled.state \
        --socket=/var/run/tailscale/tailscaled.sock \
        >> /data/tailscale/tailscaled.log 2>&1 &
    TAILSCALED_PID=$!
    # Wait for the daemon socket.
    for _ in $(seq 1 30); do
        [ -S /var/run/tailscale/tailscaled.sock ] && break
        sleep 0.5
    done
    bashio::log.info "Joining tailnet as '${hostname}'..."
    if tailscale up --authkey="${authkey}" --hostname="${hostname}" --accept-dns=false; then
        tailscale serve --bg --https=443 "http://127.0.0.1:${UPSTREAM_PORT}" || \
            bashio::log.warning "tailscale serve failed; tailnet access unavailable."
        local ts_url
        ts_url="$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty' | sed 's/\.$//')"
        [ -n "${ts_url}" ] && bashio::log.info "Tailnet access: https://${ts_url}/ (pair a client with a T3 pairing link)."
    else
        bashio::log.warning "tailscale up failed; continuing ingress-only."
    fi
}

cleanup() {
    bashio::log.info "Shutting down..."
    kill "${T3_PID}" "${PROXY_PID}" "${TAILSCALED_PID:-}" 2>/dev/null || true
}

main() {
    bashio::log.info "Initializing T3 Code add-on..."
    init_dirs
    seed_settings
    install_skills
    install_persistent_packages
    start_t3
    wait_for_t3
    mint_bearer
    start_tailscale
    start_proxy
    trap cleanup EXIT INT TERM

    bashio::log.info "T3 Code is ready — open it from the Home Assistant sidebar."
    # Exit (and let HA restart the add-on) if either child dies.
    wait -n "${T3_PID}" "${PROXY_PID}"
    bashio::log.warning "A child process exited; stopping add-on."
}

main "$@"
