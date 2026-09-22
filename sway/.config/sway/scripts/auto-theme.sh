#!/bin/bash
# ~/.config/sway/scripts/auto-theme.sh
# Automates GTK and terminal theme switching under Sway

LIGHT_THEME="Adwaita"
DARK_THEME="Adwaita-dark"
LIGHT_COLOR_SCHEME="prefer-light"
DARK_COLOR_SCHEME="prefer-dark"

KITTY_CONFIG_DIR="$HOME/.config/kitty"
mkdir -p "$KITTY_CONFIG_DIR"

write_kitty_config() {
    local mode=$1
    if [ "$mode" = "dark" ]; then
        cat <<EOF > "$KITTY_CONFIG_DIR/kitty.conf"
font_family Fira Code
font_size 12.0

foreground #ebdbb2
background #181b1c
selection_foreground #ebdbb2
selection_background #665c54
url_color #d65c0d

color0 #1d2021
color8 #928374
color1 #cc241d
color9 #fb4934
color2 #98971a
color10 #b8bb26
color3 #d79921
color11 #fabd2f
color4 #458588
color12 #83a598
color5 #b16286
color13 #d3869b
color6 #689d6a
color14 #8ec07c
color7 #a89984
color15 #ebdbb2
EOF
    else
        cat <<EOF > "$KITTY_CONFIG_DIR/kitty.conf"
font_family Fira Code
font_size 12.0

foreground #3c3836
background #fbf1c7
selection_foreground #3c3836
selection_background #a89984
url_color #d65c0d

color0 #fbf1c7
color8 #928374
color1 #cc241d
color9 #9d0006
color2 #98971a
color10 #79740e
color3 #d79921
color11 #b57614
color4 #458588
color12 #076678
color5 #b16286
color13 #8f3f71
color6 #689d6a
color14 #427b58
color7 #7c6f64
color15 #3c3836
EOF
    fi

    # Append common layout and keyboard shortcut configurations
    cat <<'EOF' >> "$KITTY_CONFIG_DIR/kitty.conf"

# --- Window Management & Splits ---
# Enable splits and stack (zoom) layouts
enabled_layouts splits,stack

# Keybindings for splitting windows (opening in same directory)
map ctrl+alt+s launch --location=hsplit --cwd=current
map ctrl+alt+v launch --location=vsplit --cwd=current

# Keybindings to move focus between splits (vi-style)
map ctrl+alt+h neighboring_window left
map ctrl+alt+l neighboring_window right
map ctrl+alt+k neighboring_window up
map ctrl+alt+j neighboring_window down

# Keybindings to swap splits
map ctrl+alt+shift+h move_window left
map ctrl+alt+shift+l move_window right
map ctrl+alt+shift+k move_window up
map ctrl+alt+shift+j move_window down

# Zoom split (toggle fullscreen zoom inside kitty)
map ctrl+shift+z toggle_layout stack
EOF

    # Send SIGUSR1 to all running kitty processes to reload config instantly
    kill -SIGUSR1 $(pgrep kitty) 2>/dev/null || true
}

set_theme() {
    local mode=$1
    if [ "$mode" = "dark" ]; then
        gsettings set org.gnome.desktop.interface color-scheme "$DARK_COLOR_SCHEME"
        gsettings set org.gnome.desktop.interface gtk-theme "$DARK_THEME"
        write_kitty_config "dark"
    else
        gsettings set org.gnome.desktop.interface color-scheme "$LIGHT_COLOR_SCHEME"
        gsettings set org.gnome.desktop.interface gtk-theme "$LIGHT_THEME"
        write_kitty_config "light"
    fi
}

toggle_theme() {
    local current=$(gsettings get org.gnome.desktop.interface color-scheme)
    if [[ "$current" == *prefer-dark* ]]; then
        set_theme "light"
    else
        set_theme "dark"
    fi
}

auto_theme() {
    local hour=$(date +%H)
    # Between 7:00 AM and 7:00 PM (19:00), use light theme; otherwise dark theme
    if [ "$hour" -ge 7 ] && [ "$hour" -lt 19 ]; then
        set_theme "light"
    else
        set_theme "dark"
    fi
}

daemon() {
    # Check the theme every 5 minutes
    while true; do
        auto_theme
        sleep 300
    done
}

case "$1" in
    toggle)
        toggle_theme
        ;;
    auto)
        auto_theme
        ;;
    daemon)
        daemon
        ;;
    light)
        set_theme "light"
        ;;
    dark)
        set_theme "dark"
        ;;
    *)
        auto_theme
        ;;
esac
