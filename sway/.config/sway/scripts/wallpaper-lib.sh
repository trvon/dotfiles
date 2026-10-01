#!/usr/bin/env bash
# ~/.config/sway/scripts/wallpaper-lib.sh
#
# Shared wallpaper selection. Sourced by auto-theme.sh and wallpaper-cycle.sh,
# not executed directly.
#
# Layout:  wallpapers/<set>-<mode>-<W>x<H>.<ext>
#
#   set    free-form, hyphens allowed (parsed from the right, so "pikes-peak"
#          works)
#   mode   light | dark
#   WxH    the *stored* pixel size. Sizes are optional and may differ per set,
#          because a set cannot offer more than its source resolution allows:
#          the Colorado photo is 6240x4160 so it ships 1920/2560/3840 wide,
#          while the ink painting is 1919x972 so it ships one native size.
#          wp_pick() takes the smallest stored size that still covers the
#          screen, else the largest available, and lets the compositor scale.
#
# The chosen set persists in ~/.config/sway/.wallpaper-set, so changing the
# theme (or reloading sway) does not reset which set you were looking at.

WP_CFG="${XDG_CONFIG_HOME:-$HOME/.config}/sway"
WP_DIR="$WP_CFG/wallpapers"
WP_SET_FILE="$WP_CFG/.wallpaper-set"
WP_TARGET="$WP_CFG/wallpaper.png"
WP_DEFAULT_SET=mountains
WP_DEFAULT_SIZE="1920 1200"

# ---------------------------------------------------------------- set state
wp_current_set() {
    local s
    s=$(cat "$WP_SET_FILE" 2>/dev/null)
    printf '%s\n' "${s:-$WP_DEFAULT_SET}"
}

wp_set_current() {
    printf '%s\n' "$1" >"$WP_SET_FILE"
}

# All set names present in the directory, sorted.
wp_sets() {
    local f name
    for f in "$WP_DIR"/*-*.*; do
        [ -e "$f" ] || continue
        name=${f##*/}
        name=$(printf '%s' "$name" | sed -nE 's/-(light|dark)-[0-9]+x[0-9]+\.[A-Za-z]+$//p')
        [ -n "$name" ] && printf '%s\n' "$name"
    done | sort -u
}

# ------------------------------------------------------------------- mode
wp_mode() {
    local m
    m=$(sed -n 1p "$WP_CFG/.theme-mode" 2>/dev/null)
    if [ -z "$m" ]; then
        if gsettings get org.gnome.desktop.interface color-scheme 2>/dev/null | grep -q prefer-dark; then
            m=dark
        else
            m=light
        fi
    fi
    printf '%s\n' "$m"
}

# ------------------------------------------------------- target resolution
# Largest active output, because that is the one that would show scaling
# artefacts first. Falls back to 1920x1200 when sway cannot be queried.
wp_target() {
    local out
    out=$(swaymsg -t get_outputs -r 2>/dev/null |
        jq -r '[.[] | select(.active) | .current_mode]
               | sort_by(.width * .height) | last
               | "\(.width) \(.height)"' 2>/dev/null)
    case "$out" in
    "" | "null null") printf '%s\n' "$WP_DEFAULT_SIZE" ;;
    *) printf '%s\n' "$out" ;;
    esac
}

# --------------------------------------------------------------- selection
# wp_pick <set> <mode> -> path (empty when the set/mode has no file)
wp_pick() {
    local set=$1 mode=$2 tw th
    read -r tw th < <(wp_target)
    [ -n "$tw" ] || read -r tw th <<<"$WP_DEFAULT_SIZE"

    local best="" best_px=-1 biggest="" big_px=-1
    local f name dims w h px
    for f in "$WP_DIR/$set-$mode"-*.*; do
        [ -e "$f" ] || continue
        name=${f##*/}
        dims=$(printf '%s' "$name" | sed -nE 's/^.*-([0-9]+)x([0-9]+)\.[A-Za-z]+$/\1 \2/p')
        [ -n "$dims" ] || continue
        w=${dims% *}
        h=${dims#* }
        px=$((w * h))
        if [ "$w" -ge "$tw" ] && [ "$h" -ge "$th" ]; then
            if [ "$best_px" -lt 0 ] || [ "$px" -lt "$best_px" ]; then
                best=$f
                best_px=$px
            fi
        fi
        if [ "$px" -gt "$big_px" ]; then
            biggest=$f
            big_px=$px
        fi
    done

    if [ -n "$best" ]; then printf '%s\n' "$best"; else printf '%s\n' "$biggest"; fi
}

# ----------------------------------------------------------------- applying
# Copies to the static path lock.sh/swayidle read, repaints sway, and mirrors
# the choice into gsettings so watch-wallpaper.sh agrees instead of fighting.
wp_apply() {
    local src=$1
    [ -r "$src" ] || return 1
    cp -f "$src" "$WP_TARGET" || return 1
    if [ -n "${SWAYSOCK:-}" ]; then
        swaymsg -q "output * background $WP_TARGET fill" 2>/dev/null
    fi
    gsettings set org.gnome.desktop.background picture-uri "file://$WP_TARGET" 2>/dev/null
    gsettings set org.gnome.desktop.background picture-uri-dark "file://$WP_TARGET" 2>/dev/null
}
