#!/usr/bin/env bash
#
# PulseAudio setup for the meet-bot container.
#
# Creates the virtual audio topology the bot needs to participate in a Google
# Meet call:
#
#   TTS output  ->  bot_out (null-sink)
#                    \_ bot_out.monitor
#                         \_ bot_mic (virtual-source, fed into Chrome as mic)
#
#   Meet audio  ->  meet_capture (null-sink; its .monitor is captured for STT)
#
# The script is idempotent — each `pactl load-module` is guarded by a check
# against the existing sink/source list so repeated invocations are no-ops.
#
# Intended to be invoked once at container start. See `pulse.ts` for the
# TypeScript wrapper that shells out to this script.

set -euo pipefail

# Start the PulseAudio daemon in the background if it is not already running.
# `--exit-idle-time=-1` prevents it from exiting when no clients are connected,
# which happens briefly between the daemon launching and Chrome attaching.
#
# Started with `--daemonize=no` in a shell background job rather than
# `--start`: --start makes pulseaudio re-execute its own binary, which
# requires canonicalizing its binary path, and that fails when pulseaudio
# runs from a relocated apt root ("Couldn't canonicalize binary path,
# cannot self execute"). A plain background process needs no self-exec, and
# its stderr flows into this script's output so daemon-side failures land
# in the captured bot log. The daemon survives this script exiting (it is
# simply reparented); the `pactl info` guard keeps repeat invocations from
# stacking daemons.
#
# PULSE_DL_SEARCH_PATH (set by the vellum worker's env augmentation when
# pulseaudio is installed under a relocated apt root like /data/system)
# points at the relocated `pulse-<version>/modules` directory; the daemon's
# compile-time module path refers to the non-relocated /usr tree, so
# without --dl-search-path every load-module below would fail.
#
# Running as root: per-user pulseaudio logs "This program is not intended
# to be run as root" as a warning but proceeds; the fatal error observed
# alongside it was the self-exec canonicalization above. If a future
# pulseaudio build makes root fatal, the sanctioned path is a --system
# instance (different socket + auth model), not suppressing the warning.
if ! pactl info >/dev/null 2>&1; then
  set -- --daemonize=no --exit-idle-time=-1 --log-target=stderr
  if [ -n "${PULSE_DL_SEARCH_PATH:-}" ]; then
    set -- "$@" --dl-search-path="${PULSE_DL_SEARCH_PATH}"
  fi
  pulseaudio "$@" &
fi

# Wait for the daemon to become reachable: the background daemon needs a
# moment to bind its socket (longer when loading relocated modules), so
# poll pactl briefly.
for _ in $(seq 1 25); do
  if pactl info >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

if ! pactl info >/dev/null 2>&1; then
  echo "pulse-setup: PulseAudio daemon did not come up" >&2
  exit 1
fi

# ---- Helpers --------------------------------------------------------------

sink_exists() {
  pactl list short sinks | awk '{print $2}' | grep -Fxq "$1"
}

source_exists() {
  pactl list short sources | awk '{print $2}' | grep -Fxq "$1"
}

# ---- bot_out: null-sink the bot's TTS output is written into --------------
if ! sink_exists bot_out; then
  pactl load-module module-null-sink \
    sink_name=bot_out \
    sink_properties=device.description=BotOutput >/dev/null
fi

# ---- bot_mic: virtual-source Chrome uses as its microphone ----------------
# Master is bot_out.monitor so whatever is played to bot_out shows up on
# bot_mic as captured audio.
if ! source_exists bot_mic; then
  pactl load-module module-virtual-source \
    source_name=bot_mic \
    master=bot_out.monitor \
    source_properties=device.description=BotMic >/dev/null
fi

# ---- meet_capture: null-sink Chrome's output is routed into ---------------
# The monitor of this sink is what Phase 3 / PR 15 taps for STT.
if ! sink_exists meet_capture; then
  pactl load-module module-null-sink \
    sink_name=meet_capture \
    sink_properties=device.description=MeetCapture >/dev/null
fi

# ---- Defaults -------------------------------------------------------------
# Chrome picks up the default source as its microphone and the default sink
# as its playback target. Setting them here means we don't have to configure
# the browser separately.
pactl set-default-source bot_mic
pactl set-default-sink meet_capture

exit 0
