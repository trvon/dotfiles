#!/usr/bin/env sh

# Terminate already running bar instances
killall -q polybar

# Wait until the processes have been shut down
while pgrep -x polybar >/dev/null; do sleep 1; done

# Launch for screen and HDMI1 
MONITOR=eDP-1 polybar top &
MONITOR=HDMI-1 polybar top &

MONITOR=eDP-1 polybar bottom &
MONITOR=HDMI-1 polybar bottom &
