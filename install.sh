#!/usr/bin/env bash
# Symlink dotfile packages into $HOME with GNU stow.
# Usage: ./install.sh [package ...]   (default: all packages)
#        ./install.sh -n              (dry run)
set -euo pipefail
cd "$(dirname "$0")"

PACKAGES=(zsh tmux sway waybar term rofi nvim fontconfig bin pi)

args=(--no-folding --target="$HOME" --verbose=1)
dry_run=0
if [[ "${1:-}" == "-n" ]]; then
    args+=(--simulate)
    dry_run=1
    shift
fi
(( $# )) && PACKAGES=("$@")

command -v stow >/dev/null || { echo "install stow first: sudo pacman -S stow" >&2; exit 1; }
stow "${args[@]}" --restow "${PACKAGES[@]}"

# waybar's style.css does @import "theme.css", which auto-theme.sh generates at
# sway startup. Ensure it exists so a first login before that runs doesn't fail
# the import and drop the whole stylesheet (unstyled bar until reload).
if (( ! dry_run )); then
    theme_css="${XDG_CONFIG_HOME:-$HOME/.config}/waybar/theme.css"
    [[ -e "$theme_css" ]] || : >"$theme_css"
fi
