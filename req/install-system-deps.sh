#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]] && ! command -v sudo >/dev/null 2>&1; then
  echo "This script needs root privileges via sudo or direct root execution." >&2
  exit 1
fi

run_root() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

install_arch() {
  run_root pacman -Sy --needed --noconfirm \
    pipewire \
    pipewire-pulse \
    wireplumber \
    pulseaudio-utils \
    xdotool \
    ffmpeg
}

install_debian() {
  run_root apt-get update
  run_root apt-get install -y \
    pipewire \
    pipewire-pulse \
    wireplumber \
    pulseaudio-utils \
    xdotool \
    ffmpeg
}

install_fedora() {
  run_root dnf install -y \
    pipewire \
    pipewire-pulseaudio \
    wireplumber \
    pulseaudio-utils \
    xdotool \
    ffmpeg
}

if command -v pacman >/dev/null 2>&1; then
  install_arch
elif command -v apt-get >/dev/null 2>&1; then
  install_debian
elif command -v dnf >/dev/null 2>&1; then
  install_fedora
else
  echo "Unsupported package manager. Install these packages manually:" >&2
  echo "pipewire, pipewire-pulse (or pipewire-pulseaudio), wireplumber, pulseaudio-utils, xdotool, ffmpeg" >&2
  exit 1
fi

cat <<'EOF'

System packages installed.

Next steps:
1. Start or restart your user audio services:
   systemctl --user enable --now pipewire pipewire-pulse wireplumber
2. Verify pactl is working:
   pactl info
3. If your app still cannot capture audio, set VIBE_RDESK_AUDIO_SOURCE to a valid monitor/source name from:
   pactl list short sources
EOF
