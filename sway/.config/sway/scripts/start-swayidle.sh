#!/usr/bin/env bash
# ~/.config/sway/scripts/start-swayidle.sh
# Safely starts a single, clean instance of the swayidle daemon.

LOCK="$HOME/.config/sway/scripts/lock.sh"
WALLPAPER="$HOME/.config/sway/wallpaper.png"

# Kill any existing swayidle instances
killall -q swayidle

# Wait a brief moment to ensure processes have exited
sleep 0.5

# Start swayidle daemon with the optimized config
# `lock` handles `loginctl lock-session` (e.g. from other apps/polkit).
exec swayidle -w \
         timeout 300 "$LOCK &" \
         timeout 600 'swaymsg "output * dpms off"' resume 'swaymsg "output * dpms on"' \
         timeout 900 'systemctl suspend' \
         lock "$LOCK &" \
         before-sleep "pgrep -x swaylock || swaylock -f -i '$WALLPAPER' -s fill"
