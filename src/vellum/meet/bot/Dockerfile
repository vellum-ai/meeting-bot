# meet-bot container image.
#
# Runs the Meet bot inside a Debian-based Bun image with Xvfb (virtual
# display), PulseAudio (virtual audio devices), chromium (Debian package, for
# the `--load-extension` support required by the extension-based meet-join
# architecture — google-chrome-stable silently strips that flag as of
# Chrome 128+), and ffmpeg for future audio capture/encoding needs.
#
# NOTE: Meet's BotGuard accepts chromium launched as a plain subprocess
# (no CDP attachment) but rejects Chrome-with-CDP. Build with
# `--platform linux/amd64` for parity with other amd64 dependencies.
#
# Build context: the PLUGIN REPO ROOT (not this directory). The bot's
# dependencies live in the plugin's root package.json (consolidated so a
# plain `bun install` at plugin install time covers the bot too), so the
# image install step needs the root package.json + bun.lock. Build with:
#
#   docker build --platform linux/amd64 \
#     -f src/vellum/meet/bot/Dockerfile -t vellum-meet-bot:dev .
#
# `Dockerfile.dockerignore` narrows the context back down to the copied
# paths. It is named `Dockerfile.dockerignore` (not `.dockerignore`) so it
# applies to this Dockerfile specifically. See:
# https://docs.docker.com/build/concepts/context/#dockerignore-files

FROM oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7

# UTF-8 locale for every process in the image. Without this the container
# defaults to POSIX/C locale and locale-aware tools refuse non-ASCII bytes —
# `xdotool type` aborts a chat message on the first multi-byte character
# (curly apostrophe, em-dash, emoji) with `Invalid multi-byte sequence
# encountered`, leaving the composer holding a truncated message that the
# subsequent send click then commits. Modern Debian (the base for
# `oven/bun`) ships `C.UTF-8` without needing the `locales` package.
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8

# System dependencies. Keep this list grouped and sorted so future PRs can
# add/remove packages cleanly.
#
#   Xvfb + PulseAudio: virtual display and audio stack for headless Chromium.
#   ca-certificates:   TLS trust store for any outbound HTTPS the bot makes
#                      at runtime.
#   dbus-x11:          required at runtime by Chromium.
#   ffmpeg:            audio/video encoding for transcript + recording paths.
#                      Also used to convert the avatar renderer's output frames
#                      into Y4M / YU12 for the v4l2loopback virtual camera.
#   fonts-liberation/libvulkan1/xdg-utils: chromium runtime deps.
#   libnss3/libgbm1/libasound2: Chromium shared-library dependencies.
#   v4l2loopback-utils: ships `v4l2-ctl`, used by `media/video-device.ts`
#                      to configure the virtual camera's pixel format when the
#                      avatar feature is enabled. The kernel module itself is
#                      loaded on the HOST (see README "Avatar (v4l2loopback)
#                      host setup") — the container only needs the userspace
#                      tooling so it can talk to the bind-mounted
#                      `/dev/video10` node.
#   xdotool:           posts trusted X-server mouse events for buttons that
#                      Meet gates on `event.isTrusted` (the prejoin admission
#                      button is the main one — JS `.click()` from the
#                      extension is silently ignored).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    dbus-x11 \
    ffmpeg \
    fonts-liberation \
    libasound2 \
    libgbm1 \
    libnss3 \
    libvulkan1 \
    pulseaudio \
    pulseaudio-utils \
    v4l2loopback-utils \
    xdg-utils \
    xdotool \
    xvfb \
    && rm -rf /var/lib/apt/lists/*

# Install Debian's chromium (NOT google-chrome-stable). As of Chrome 128+,
# google-chrome-stable silently strips the `--load-extension` command-line
# flag ("--load-extension is not allowed in Google Chrome, ignoring"), which
# blocks our extension-based architecture. Chromium keeps the flag working
# and is otherwise indistinguishable to Meet's BotGuard when launched as a
# plain subprocess without CDP attachment. Per CLAUDE.md's Docker
# dependencies rule, package versions are NOT pinned — rely on the
# base-image digest for reproducibility.
RUN apt-get update && apt-get install -y --no-install-recommends chromium \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/bot

# Copy the sibling directories the bot imports via relative paths:
# `contracts/` (event schemas; resolves as `../contracts` from /app/bot and
# `../../contracts` from /app/bot/<dir>) and `shared/` (the avatar device
# path constant, `../../shared` from /app/bot/{browser,media}).
COPY src/vellum/meet/contracts /app/contracts
COPY src/vellum/meet/shared /app/shared

# Install JS dependencies from the plugin root manifest first so Docker can
# cache the layer when only source files change.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# The contracts/ directory has no package.json and no node_modules of its own,
# but its TS files import `zod`. Both the bot (at runtime) and the extension
# build (which imports contracts via relative paths) need zod resolvable from
# /app/contracts/. Symlink the bot's node_modules in so Node/Bun's upward
# module resolution finds zod when walking up from /app/contracts/*.ts.
RUN mkdir -p /app/contracts/node_modules \
  && ln -sf /app/bot/node_modules/zod /app/contracts/node_modules/zod

# Bot sources live directly under bot/ (no src/ nesting).
COPY src/vellum/meet/bot ./

# Build the Chrome extension and install its dist/ at /app/ext/. The
# chrome-launcher passes `--load-extension=/app/ext` so Chrome picks it
# up on startup. We build inside the image (rather than shipping a
# pre-built dist/ in the repo) so the extension source is the single
# source of truth. `/app/ext-src` is throwaway; the final artefact is
# `/app/ext/` which contains manifest.json, background.js, content.js.
COPY src/vellum/meet/meet-controller-ext /app/ext-src
RUN cd /app/ext-src && bun install --frozen-lockfile && bun run build \
  && cp -r /app/ext-src/dist /app/ext \
  && rm -rf /app/ext-src

# Native-messaging host registration: render the manifest with the
# extension's ID baked in (derived from the extension package's public key).
# The rendered file lands at Chrome's well-known search path so Chromium
# picks it up automatically when it boots inside the container.
COPY src/vellum/meet/meet-controller-ext/manifest.json /tmp/ext-manifest.json

RUN mkdir -p /etc/chromium/native-messaging-hosts \
  && bun scripts/render-nmh-manifest.ts \
       /etc/chromium/native-messaging-hosts/com.vellum.meet.json \
       --ext-manifest /tmp/ext-manifest.json \
       --template /app/bot/native-messaging/com.vellum.meet.json \
  && chmod +x /app/bot/native-messaging/nmh-shim.ts \
  && rm /tmp/ext-manifest.json

# The PulseAudio bootstrap script is shelled out to at container start by
# `media/pulse.ts`; ensure the executable bit is set in the image so the
# runtime `bash` invocation succeeds. The script is NOT run at build time —
# PulseAudio needs a live container environment (runtime, not image layer).
RUN chmod +x /app/bot/media/pulse-setup.sh

# The placeholder probe lives at health.ts and exits 0; real health
# logic lands in a later PR (see meet-phase-1 plan PR 8).
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD bun health.ts || exit 1

CMD ["bun", "main.ts"]
