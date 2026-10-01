#!/usr/bin/env bash
# ~/.config/sway/scripts/swaynag-exit.sh
# The "$mod+Shift+e" exit prompt, styled from the generated theme so it keeps
# matching the current light/dark mode. swaynag colours can only be given on
# the command line, hence this wrapper.

set -uo pipefail

THEME_SH="${HOME}/.config/sway/theme.sh"

THEME_BG=fbf1c7
THEME_FG=3c3836
THEME_ACCENT=b57614
# shellcheck disable=SC1090
[ -r "$THEME_SH" ] && . "$THEME_SH"

exec swaynag \
    -t warning \
    -f 'JetBrainsMono Nerd Font 10' \
    -m 'Exit sway? This ends your Wayland session.' \
    --background "$THEME_BG" \
    --border "$THEME_ACCENT" \
    --text "$THEME_FG" \
    --button-background "$THEME_ACCENT" \
    --button-text "$THEME_BG" \
    -B 'Exit' 'swaymsg exit'
