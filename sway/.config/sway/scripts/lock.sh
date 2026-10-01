#!/usr/bin/env bash
# ~/.config/sway/scripts/lock.sh
# Locks the screen and manages short display sleep timeout while locked.
#
# All colours come from the generated ~/.config/sway/theme.sh, so the lock
# screen matches the current light/dark theme. There is exactly one lock path
# in the dotfiles: start-swayidle.sh calls this script for both idle and
# before-sleep, so every route produces the same lockscreen.

set -uo pipefail

WALLPAPER="${HOME}/.config/sway/wallpaper.png"
THEME_SH="${HOME}/.config/sway/theme.sh"

# Force locking even if a lock is already up (used by before-sleep).
FORCE=0
[[ "${1:-}" == "-f" || "${1:-}" == "--force" ]] && FORCE=1

if ((!FORCE)) && pgrep -x swaylock >/dev/null; then
    exit 0
fi

# Fallback values if the theme has never been generated (bare hex for swaylock).
SWAYLOCK_RING=b57614
SWAYLOCK_KEY_HL=3c3836
SWAYLOCK_TEXT=3c3836
SWAYLOCK_INSIDE=00000088
SWAYLOCK_LINE=00000000
THEME_RED=9d0006
# shellcheck disable=SC1090
[ -r "$THEME_SH" ] && . "$THEME_SH"

IDLE_PID=""
cleanup() {
    if [ -n "$IDLE_PID" ]; then
        kill "$IDLE_PID" 2>/dev/null
    fi
    if [ -n "${SWAYSOCK:-}" ]; then
        swaymsg -q "output * dpms on" 2>/dev/null
    fi
}
trap cleanup EXIT INT TERM

# Turn the screen off shortly after locking.
swayidle -w \
    timeout 10 'swaymsg -q "output * dpms off"' \
    resume 'swaymsg -q "output * dpms on"' &
IDLE_PID=$!

# Non-colour settings live in ~/.config/swaylock/config; colours are passed
# explicitly so they follow the theme.
swaylock \
    --config "${HOME}/.config/swaylock/config" \
    -i "$WALLPAPER" -s fill \
    --ring-color "$SWAYLOCK_RING" \
    --key-hl-color "$SWAYLOCK_KEY_HL" \
    --text-color "$SWAYLOCK_TEXT" \
    --ring-ver-color "$SWAYLOCK_RING" \
    --ring-clear-color "$SWAYLOCK_KEY_HL" \
    --ring-caps-lock-color "$SWAYLOCK_KEY_HL" \
    --ring-wrong-color "$THEME_RED" \
    --text-wrong-color "$THEME_RED" \
    --inside-color "$SWAYLOCK_INSIDE" \
    --inside-ver-color "$SWAYLOCK_INSIDE" \
    --inside-clear-color "$SWAYLOCK_INSIDE" \
    --inside-caps-lock-color "$SWAYLOCK_INSIDE" \
    --inside-wrong-color "$SWAYLOCK_INSIDE" \
    --line-color "$SWAYLOCK_LINE" \
    --separator-color "$SWAYLOCK_LINE"
