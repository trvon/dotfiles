#!/usr/bin/env bash
# ~/.local/bin/disk-stats.sh
#
# Backing script for the waybar "custom/disk" module.
#   ~/.config/waybar/config -> custom/disk -> { "exec": "$HOME/.local/bin/disk-stats.sh", "interval": 60 }
#
# Emits a single line:  <root %> / | <pool> <cap> | <free> free
# Colored by root-filesystem pressure. Requires escape:false in the waybar
# module config for the Pango markup to render.

set -uo pipefail

pct() { df -h --output=pcent "$1" 2>/dev/null | tail -1 | tr -d ' %'; }

root_pct=$(pct /)
root_pct=${root_pct:-0}
home_free=$(df -h --output=avail "$HOME" 2>/dev/null | tail -1 | tr -d ' ')
home_free=${home_free:-?}

# ZFS pool capacity (the machine's root pool)
pool_line=$(zpool list -H -o name,cap zroot 2>/dev/null | awk '{print $1, $2}')
pool_name=${pool_line%% *}
pool_pct=${pool_line##* }
[ -n "$pool_name" ] || { pool_name="zroot"; pool_pct="?"; }

if   [ "$root_pct" -ge 90 ] 2>/dev/null; then color="#f38ba8"
elif [ "$root_pct" -ge 75 ] 2>/dev/null; then color="#fab387"
else color="#a6e3a1"; fi

printf '<span color="%s">%s%%</span> / | %s %s | %s free\n' \
    "$color" "$root_pct" "$pool_name" "$pool_pct" "$home_free"
