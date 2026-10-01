#!/usr/bin/env bash
# ~/.config/sway/scripts/auto-theme.sh
#
# Single source of truth for light/dark across the desktop.
#
# Who follows what:
#   GTK       written here (gsettings color-scheme + gtk-theme)
#   Ghostty   reads the same gsettings key itself (theme = light:...,dark:...)
#   Neovim    reads gsettings (~/.config/nvim/lua/config/theme.lua)
#   waybar    generated theme.css, imported by style.css  -> SIGUSR2 reload
#   sway      runtime `swaymsg client.*` (no config include: a missing include
#             would hard-fail sway on a fresh install)
#   mako      generated config from the tracked config.template -> makoctl reload
#   rofi      generated colors/current.rasi, imported by the launcher theme
#   swaylock  generated theme.sh, sourced by lock.sh and swaynag-exit.sh
#   wallpaper wallpapers/<set>-<mode>-<WxH>.{jpg,png} copied to wallpaper.png
#             (set + size chosen by wallpaper-lib.sh; see wallpapers/README.md)
#   kitty     generated kitty.conf (kitty is not part of the dotfiles repo)
#
# Generated files are live-only and never tracked, same as kitty.conf and
# wallpaper.png. Tracked sources: mako/config.template, rofi/colors/gruvbox-*.rasi.
#
# Usage: auto-theme.sh [auto|toggle|light|dark|daemon] [--force]

set -uo pipefail

CFG="${XDG_CONFIG_HOME:-$HOME/.config}"
STATE="$CFG/sway/.theme-mode"
VARS="$CFG/sway/theme.sh"

# Set/size picking and the applied-file convention live in wallpaper-lib.sh.
# shellcheck source=/dev/null
. "$CFG/sway/scripts/wallpaper-lib.sh"

# ---------------------------------------------------------------- desired mode
# Time-based. This is the authority; gsettings is an output that other
# components (Ghostty, Neovim) read back.
time_mode() {
    local h
    h=$(date +%H)
    if ((10#$h >= 7 && 10#$h < 19)); then echo light; else echo dark; fi
}

# Mode currently advertised to the rest of the desktop.
setting_mode() {
    local s
    s=$(gsettings get org.gnome.desktop.interface color-scheme 2>/dev/null)
    [[ $s == *prefer-dark* ]] && echo dark || echo light
}

# ------------------------------------------------------------------- palettes
# Gruvbox, matching the Ghostty themes (Light / Dark Hard).
palette() {
    case "$1" in
    dark)
        BG='#1d2021'; BG_ALT='#3c3836'; FG='#ebdbb2'; GRAY='#928374'
        ACCENT='#fabd2f'; RED='#fb4934'; GREEN='#b8bb26'; YELLOW='#fabd2f'
        BLUE='#83a598'; AQUA='#8ec07c'; PURPLE='#d3869b'; ORANGE='#fe8019'
        GTK_THEME='Adwaita-dark'; COLOR_SCHEME='prefer-dark'
        TERM_BG='#181b1c'; TERM_FG='#ebdbb2'
        TERM_SEL_FG='#ebdbb2'; TERM_SEL_BG='#665c54'
        TERM_0='#1d2021'; TERM_1='#cc241d'; TERM_2='#98971a'; TERM_3='#d79921'
        TERM_4='#458588'; TERM_5='#b16286'; TERM_6='#689d6a'; TERM_7='#a89984'
        TERM_8='#928374'; TERM_9='#fb4934'; TERM_10='#b8bb26'; TERM_11='#fabd2f'
        TERM_12='#83a598'; TERM_13='#d3869b'; TERM_14='#8ec07c'; TERM_15='#ebdbb2'
        ;;
    light)
        BG='#fbf1c7'; BG_ALT='#ebdbb2'; FG='#3c3836'; GRAY='#928374'
        ACCENT='#b57614'; RED='#9d0006'; GREEN='#79740e'; YELLOW='#b57614'
        BLUE='#076678'; AQUA='#427b58'; PURPLE='#8f3f71'; ORANGE='#d65c0d'
        GTK_THEME='Adwaita'; COLOR_SCHEME='prefer-light'
        TERM_BG='#fbf1c7'; TERM_FG='#3c3836'
        TERM_SEL_FG='#3c3836'; TERM_SEL_BG='#a89984'
        TERM_0='#fbf1c7'; TERM_1='#cc241d'; TERM_2='#98971a'; TERM_3='#d79921'
        TERM_4='#458588'; TERM_5='#b16286'; TERM_6='#689d6a'; TERM_7='#7c6f64'
        TERM_8='#928374'; TERM_9='#9d0006'; TERM_10='#79740e'; TERM_11='#b57614'
        TERM_12='#076678'; TERM_13='#8f3f71'; TERM_14='#427b58'; TERM_15='#3c3836'
        ;;
    *)
        echo "auto-theme: unknown mode '$1'" >&2
        return 1
        ;;
    esac
}

# ---------------------------------------------------------------- generators
gen_kitty() {
    mkdir -p "$CFG/kitty"
    cat >"$CFG/kitty/kitty.conf" <<EOF
font_family FiraCode Nerd Font
font_size 12.0

foreground $TERM_FG
background $TERM_BG
selection_foreground $TERM_SEL_FG
selection_background $TERM_SEL_BG
url_color $ORANGE

color0 $TERM_0
color8 $TERM_8
color1 $TERM_1
color9 $TERM_9
color2 $TERM_2
color10 $TERM_10
color3 $TERM_3
color11 $TERM_11
color4 $TERM_4
color12 $TERM_12
color5 $TERM_5
color13 $TERM_13
color6 $TERM_6
color14 $TERM_14
color7 $TERM_7
color15 $TERM_15
EOF
    cat >>"$CFG/kitty/kitty.conf" <<'EOF'

# --- Window Management & Splits ---
enabled_layouts splits,stack

map ctrl+alt+s launch --location=hsplit --cwd=current
map ctrl+alt+v launch --location=vsplit --cwd=current

map ctrl+alt+h neighboring_window left
map ctrl+alt+l neighboring_window right
map ctrl+alt+k neighboring_window up
map ctrl+alt+j neighboring_window down

map ctrl+alt+shift+h move_window left
map ctrl+alt+shift+l move_window right
map ctrl+alt+shift+k move_window up
map ctrl+alt+shift+j move_window down

map ctrl+shift+z toggle_layout stack
EOF
}

gen_waybar() {
    mkdir -p "$CFG/waybar"
    cat >"$CFG/waybar/theme.css" <<EOF
/* GENERATED by ~/.config/sway/scripts/auto-theme.sh -- do not edit.
 * Imported by style.css. Palette: gruvbox ($1). */
@define-color bg $BG;
@define-color bg_alt $BG_ALT;
@define-color fg $FG;
@define-color gray $GRAY;
@define-color accent $ACCENT;
@define-color red $RED;
@define-color green $GREEN;
@define-color yellow $YELLOW;
@define-color blue $BLUE;
@define-color aqua $AQUA;
@define-color purple $PURPLE;
@define-color orange $ORANGE;
EOF
}

gen_sway_vars() {
    # Bare hex (no leading '#') on purpose: swaylock-effects and swaynag both
    # take RRGGBB[AA], not #RRGGBB.
    cat >"$VARS" <<EOF
# GENERATED by ~/.config/sway/scripts/auto-theme.sh -- do not edit.
# Sourced by lock.sh and swaynag-exit.sh. Palette: gruvbox ($1).
THEME_MODE=$1
THEME_BG=${BG#\#}
THEME_BG_ALT=${BG_ALT#\#}
THEME_FG=${FG#\#}
THEME_GRAY=${GRAY#\#}
THEME_ACCENT=${ACCENT#\#}
THEME_RED=${RED#\#}

SWAYLOCK_RING=${ACCENT#\#}
SWAYLOCK_KEY_HL=${FG#\#}
SWAYLOCK_TEXT=${FG#\#}
SWAYLOCK_INSIDE=00000088
SWAYLOCK_LINE=00000000
EOF
}

gen_mako() {
    local tpl="$CFG/mako/config.template"
    [ -r "$tpl" ] || return 0
    sed -e "s|@BG@|$BG|g" \
        -e "s|@BG_ALT@|$BG_ALT|g" \
        -e "s|@FG@|$FG|g" \
        -e "s|@ACCENT@|$ACCENT|g" \
        -e "s|@RED@|$RED|g" \
        "$tpl" >"$CFG/mako/config"
}

gen_rofi() {
    local src="$CFG/rofi/colors/gruvbox-$1.rasi"
    [ -r "$src" ] || return 0
    cp -f "$src" "$CFG/rofi/colors/current.rasi"
}

# Wallpaper. The set in use is remembered in .wallpaper-set and the size is
# chosen for the current output by wallpaper-lib.sh; WALLPAPER_NAME overrides
# the remembered set for a single run. To keep one fixed wallpaper instead,
# delete this call from set_theme().
apply_wallpaper() {
    local set src
    set=${WALLPAPER_NAME:-$(wp_current_set)}
    src=$(wp_pick "$set" "$1")
    [ -n "$src" ] || return 0
    wp_apply "$src"
}

# ------------------------------------------------------------------ appliers
reload() {
    pkill -SIGUSR1 -x kitty 2>/dev/null
    pkill -SIGUSR2 -x waybar 2>/dev/null
    command -v makoctl >/dev/null && makoctl reload 2>/dev/null
    [ -n "${SWAYSOCK:-}" ] && swaymsg -q reload 2>/dev/null
    return 0
}

# Colours that sway can only be told about at runtime. Safe to call on every
# config reload: it never triggers a reload itself.
#
# swaymsg joins argv with spaces, so several commands must be passed as ONE
# ';'-separated string. Passed as separate arguments sway rejects them with
# "Invalid client.focused command (expected at most 5 arguments, got 11)" -
# and because the reply was unchecked that failure was silent: the borders
# just stayed on the static values from the sway config. Hence the explicit
# success check below.
sway_runtime_colors() {
    [ -n "${SWAYSOCK:-}" ] || return 0
    local cmds reply
    cmds="client.focused $ACCENT $BG_ALT $FG $ACCENT $ACCENT"
    cmds+="; client.focused_inactive $GRAY $BG $GRAY $GRAY $GRAY"
    cmds+="; client.unfocused $GRAY $BG $GRAY $GRAY $GRAY"
    cmds+="; client.urgent $RED $BG_ALT $FG $RED $RED"
    reply=$(swaymsg -t command "$cmds" 2>&1)
    case "$reply" in
    *'"success": false'*)
        echo "auto-theme: could not set border colours: $reply" >&2
        ;;
    esac
    return 0
}

set_theme() {
    local mode=$1
    palette "$mode" || return 1

    gsettings set org.gnome.desktop.interface color-scheme "$COLOR_SCHEME"
    gsettings set org.gnome.desktop.interface gtk-theme "$GTK_THEME"

    gen_kitty
    gen_waybar "$mode"
    gen_sway_vars "$mode"
    gen_mako
    gen_rofi "$mode"
    apply_wallpaper "$mode"
    sway_runtime_colors
    reload
}

# ------------------------------------------------------------------- entrypts
# state file: line 1 = applied mode, line 2 = time-based mode when applied.
# Keeping line 2 lets a manual toggle stick until the next day/night boundary
# instead of being reverted by the next 5-minute daemon tick.
read_applied() { [ -r "$STATE" ] && sed -n 1p "$STATE"; }
read_anchor() { [ -r "$STATE" ] && sed -n 2p "$STATE"; }
write_state() { printf '%s\n%s\n' "$1" "$2" >"$STATE"; }

apply() { # apply <force:0|1>
    local t a t0
    t=$(time_mode); a=$(read_applied); t0=$(read_anchor)
    if [[ "$1" != 1 && "$t" == "$t0" && -n "$a" ]]; then
        # Same half of the day: keep whatever is applied (may be a manual
        # override) but re-assert the runtime bits that a sway reload resets.
        palette "$a" && sway_runtime_colors
        return 0
    fi
    set_theme "$t" && write_state "$t" "$t"
}

set_explicit() { # set_explicit <mode>
    set_theme "$1" && write_state "$1" "$(time_mode)"
}

case "${1:-auto}" in
toggle)
    if [[ "$(setting_mode)" == dark ]]; then set_explicit light; else set_explicit dark; fi
    notify-send -a theme -t 1500 "Theme" "Switched to $(read_applied)" 2>/dev/null
    ;;
light | dark)
    set_explicit "$1"
    notify-send -a theme -t 1500 "Theme" "Set to $1" 2>/dev/null
    ;;
daemon)
    # Force once at startup so generated files exist even if the state file says
    # otherwise (fresh machine, or a sway reload after a manual file edit).
    apply 1
    while true; do
        sleep 300
        apply 0
    done
    ;;
auto)
    apply 0
    ;;
*)
    echo "usage: $0 [auto|toggle|light|dark|daemon] [--force]" >&2
    exit 1
    ;;
esac
