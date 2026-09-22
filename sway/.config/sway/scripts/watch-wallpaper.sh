#!/bin/bash
# ~/.config/sway/scripts/watch-wallpaper.sh
# Monitors GNOME wallpaper changes and applies them dynamically to Sway & Swaylock

apply_wallpaper() {
    local raw_uri=$1
    # Remove single quotes
    local uri=$(echo "$raw_uri" | sed -e "s/^'//" -e "s/'$//")
    # Remove file:// prefix
    local filepath="${uri#file://}"
    
    # URL decode filepath (replaces hex sequences like %20 with actual characters)
    filepath=$(echo -e "${filepath//%/\\x}")
    
    if [ -f "$filepath" ]; then
        echo "Applying wallpaper: $filepath"
        # Update current Sway output background
        swaymsg output "*" background "$filepath" fill
        
        # Copy to the static path so swaylock/swayidle pick it up automatically
        cp "$filepath" "$HOME/.config/sway/wallpaper.png" 2>/dev/null || true
    fi
}

# Initial apply at startup
current_uri=$(gsettings get org.gnome.desktop.background picture-uri)
apply_wallpaper "$current_uri"

# Monitor GSettings key for changes
gsettings monitor org.gnome.desktop.background picture-uri | while read -r line; do
    # Extract the raw URI value after the colon
    raw_val=$(echo "$line" | cut -d: -f2- | xargs)
    apply_wallpaper "$raw_val"
done
