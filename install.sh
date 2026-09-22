#!/usr/bin/env bash
# Symlink dotfile packages into $HOME with GNU stow.
# Usage: ./install.sh [package ...]   (default: all packages)
#        ./install.sh -n              (dry run)
set -euo pipefail
cd "$(dirname "$0")"

PACKAGES=(zsh tmux sway waybar term rofi bin pi)

args=(--no-folding --target="$HOME" --verbose=1)
if [[ "${1:-}" == "-n" ]]; then
    args+=(--simulate)
    shift
fi
(( $# )) && PACKAGES=("$@")

command -v stow >/dev/null || { echo "install stow first: sudo pacman -S stow" >&2; exit 1; }
stow "${args[@]}" --restow "${PACKAGES[@]}"
