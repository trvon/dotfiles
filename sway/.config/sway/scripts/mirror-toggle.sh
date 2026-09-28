#!/usr/bin/env bash
# ~/.config/sway/scripts/mirror-toggle.sh
# Toggle mirroring the laptop panel onto the first active external output
# (wl-mirror, fullscreen, scaled to fit).

SOURCE="eDP-1"

if pgrep -x wl-mirror >/dev/null; then
    pkill -x wl-mirror
    exit 0
fi

target=$(swaymsg -t get_outputs -r | jq -r --arg src "$SOURCE" \
    '[.[] | select(.active and .name != $src)][0].name // empty')

if [ -z "$target" ]; then
    notify-send -a wl-mirror "Screen mirror" "No external display connected"
    exit 1
fi

exec wl-mirror --fullscreen-output "$target" --scaling fit "$SOURCE"
