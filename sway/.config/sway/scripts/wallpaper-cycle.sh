#!/usr/bin/env bash
# ~/.config/sway/scripts/wallpaper-cycle.sh
#
# Step through the wallpapers so you can look at them live. Bound to
# $mod+Shift+b.
#
#   wallpaper-cycle.sh next           next wallpaper, wraps
#   wallpaper-cycle.sh prev           previous wallpaper
#   wallpaper-cycle.sh list           every entry, current one marked *
#   wallpaper-cycle.sh use <set>      switch set (current mode's file)
#   wallpaper-cycle.sh apply <file>   apply one arbitrary image (preview)
#
# An "entry" is a set x mode pair, so each wallpaper is shown once even when it
# is stored in several sizes - the size is chosen for the current output by
# wallpaper-lib.sh.
#
# Entries for the *current* mode come first, then the other mode's, flagged in
# the notification. Cycling restricted to the current mode was the earlier
# behaviour and made the dark images unreachable without also toggling the
# theme, which defeats the point of a preview key.
#
# The set is remembered in ~/.config/sway/.wallpaper-set, so a theme change
# afterwards shows the same set in the new mode.
set -uo pipefail

CFG="${XDG_CONFIG_HOME:-$HOME/.config}"
# shellcheck source=/dev/null
. "$CFG/sway/scripts/wallpaper-lib.sh"

# Every set x mode that has files, current mode first: "set mode" per line.
wp_entries() {
    local mode other s
    mode=$(wp_mode)
    if [ "$mode" = dark ]; then other=light; else other=dark; fi
    for mode in "$mode" "$other"; do
        for s in $(wp_sets); do
            if [ -n "$(wp_pick "$s" "$mode")" ]; then
                printf '%s %s\n' "$s" "$mode"
            fi
        done
    done
}

apply_entry() {
    local set=$1 mode=$2 src cur
    src=$(wp_pick "$set" "$mode")
    if [ -z "$src" ]; then
        notify-send -a wallpaper "Wallpaper" "No '$set-$mode' image in $WP_DIR" 2>/dev/null
        return 1
    fi
    wp_set_current "$set"
    wp_apply "$src" || return 1
    cur=$(wp_mode)
    if [ "$mode" != "$cur" ]; then
        notify-send -a wallpaper -t 2500 "Wallpaper" \
            "$(basename "$src" | sed 's/\.[^.]*$//')  (for the other mode)" 2>/dev/null
    else
        notify-send -a wallpaper -t 2500 "Wallpaper" \
            "$(basename "$src" | sed 's/\.[^.]*$//')" 2>/dev/null
    fi
}

case "${1:-next}" in
list)
    # Mark by what is actually applied, not by set+mode: after previewing the
    # other mode's file, set and mode no longer identify the entry on screen.
    while read -r s m; do
        mark=" "
        cmp -s "$WP_TARGET" "$(wp_pick "$s" "$m")" 2>/dev/null && mark="*"
        printf '%s %-10s %-5s %s\n' "$mark" "$s" "$m" \
            "$(basename "$(wp_pick "$s" "$m")")"
    done < <(wp_entries)
    ;;
use)
    set=${2:-}
    if [ -z "$set" ]; then
        echo "usage: $0 use <set>" >&2
        exit 1
    fi
    apply_entry "$set" "$(wp_mode)"
    ;;
apply)
    f=${2:-}
    if [ -z "$f" ]; then
        echo "usage: $0 apply <file>" >&2
        exit 1
    fi
    [ -f "$f" ] || f="$WP_DIR/$f"
    if [ ! -f "$f" ]; then
        echo "no such wallpaper: $f" >&2
        exit 1
    fi
    wp_apply "$f" && notify-send -a wallpaper -t 2500 "Wallpaper" \
        "$(basename "$f" | sed 's/\.[^.]*$//')" 2>/dev/null
    ;;
next | prev)
    mapfile -t entries < <(wp_entries)
    n=${#entries[@]}
    if [ "$n" -eq 0 ]; then
        notify-send -a wallpaper "Wallpaper" "No wallpapers in $WP_DIR" 2>/dev/null
        exit 1
    fi
    # Start from whatever is on screen: match the applied file against every
    # entry's resolved path, so there is no index to go stale.
    idx=0
    for ((k = 0; k < n; k++)); do
        read -r s m <<<"${entries[k]}"
        if cmp -s "$WP_TARGET" "$(wp_pick "$s" "$m")" 2>/dev/null; then
            idx=$k
            break
        fi
    done
    if [ "$1" = next ]; then
        i=$(((idx + 1) % n))
    else
        i=$(((idx - 1 + n) % n))
    fi
    read -r s m <<<"${entries[i]}"
    apply_entry "$s" "$m"
    ;;
*)
    echo "usage: $0 [next|prev|list|use <set>|apply <file>]" >&2
    exit 1
    ;;
esac
