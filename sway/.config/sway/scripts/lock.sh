#!/usr/bin/env bash
# ~/.config/sway/scripts/lock.sh
# Locks the screen and manages short display sleep timeout while locked.

# If swaylock is already running, exit immediately to prevent duplicates
if pgrep -x swaylock >/dev/null; then
    exit 0
fi

WALLPAPER="${HOME}/.config/sway/wallpaper.png"

# Clean up background process on exit
cleanup() {
    if [ -n "$IDLE_PID" ]; then
        kill "$IDLE_PID" 2>/dev/null
    fi
    swaymsg "output * dpms on"
}
trap cleanup EXIT INT TERM

# Start swayidle to turn off the screen after 10 seconds of inactivity while locked
swayidle -w \
    timeout 10 'swaymsg "output * dpms off"' \
    resume 'swaymsg "output * dpms on"' &
IDLE_PID=$!

# Run swaylock in the foreground (blocking)
swaylock -i "$WALLPAPER" -s fill \
    --indicator-radius 75 \
    --indicator-thickness 7 \
    --ring-color bb00cc \
    --key-hl-color 880033 \
    --line-color 00000000 \
    --inside-color 00000088 \
    --separator-color 00000000
