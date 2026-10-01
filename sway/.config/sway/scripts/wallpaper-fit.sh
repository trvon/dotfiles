#!/usr/bin/env bash
# ~/.config/sway/scripts/wallpaper-fit.sh
#
# Score an image as a wallpaper for this gruvbox light/dark setup.
#
# Usage: wallpaper-fit.sh <image> [...]
#
# A wallpaper in a tiling setup is not judged on its own, it is judged on the
# slivers visible around 11px gaps, a 2px border and a top bar. Four numbers
# decide it:
#
#   lum    mean luminance (0-1)
#          Light mode wants >= ~0.7, dark mode <= ~0.3. A mid-tone image
#          (~0.4-0.6) fights BOTH themes, because it is neither a dark nor a
#          light surface next to the bar and window chrome.
#
#   chrm   mean chroma (0-1), i.e. how far from grey the average pixel is:
#          mean(max(R,G,B) - min(R,G,B)) / 255, averaged over the image.
#          Gruvbox is warm and muted, so a backdrop wants to stay low. Do NOT
#          use HSL/HSV saturation here, which lies at the extremes of
#          lightness: pure gruvbox cream #fbf1c7 reports saturation 0.87 and
#          is obviously not a vivid colour, while magenta reports 1.00. Chroma
#          gets cream right (0.20) and magenta right (1.00).
#
#   busy   % of pixel area that is an edge (0-1), resolution-independent
#          The one people forget. High-frequency detail (foliage, crowds,
#          gravel, brick) becomes visual noise when 90% of it is hidden behind
#          windows. Under ~0.02 is calm; over ~0.08 is a texture, not a
#          backdrop. Measured as the share of pixels an edge filter fires on,
#          not the mean edge brightness - the latter is swamped by the large
#          flat regions and reads as 0 for everything.
#
#   flat   % of area taken by the single most common colour. A calm backdrop
#          is usually >= ~35%: one dominant surface (sky, fog, water) with a
#          small subject on top.
#
#   fit    % of pixel area already within 25 RGB units of a gruvbox colour,
#          plus the mean distance to the nearest one. High fit means the image
#          needs no retinting; low fit means remap it (see below) or it will
#          look like a foreign object.
#
# Retinting a good-but-off-palette photo:
#   magick in.png -resize 1920x1200^ -gravity center -extent 1920x1200 \
#     +dither -remap <palette.png> out.png
# where <palette.png> is a 16x1 strip of the gruvbox colours. Run this same
# script on the result to confirm the fit actually improved.
set -uo pipefail

# Gruvbox family: both modes, greys + accents.
HEXES=(1d2021 282828 3c3836 504945 665c54 7c6f64 928374 ebdbb2 d5c4a1
    fbf1c7 f2e5bc bdae93 a89984 fb4934 b8bb26 fabd2f 83a598 d3869b 8ec07c
    fe8019 9d0006 79740e b57614 076678 8f3f71 427b58 d65c0d)

palette=""
for h in "${HEXES[@]}"; do
    r=$((16#${h:0:2}))
    g=$((16#${h:2:2}))
    b=$((16#${h:4:2}))
    palette+="$r,$g,$b "
done

printf '%-40s %5s %5s %6s %5s %5s %6s  %s\n' image lum chrm busy flat fit meanD verdict

for img in "$@"; do
    if [ ! -r "$img" ]; then
        printf '%-40s cannot read\n' "$(basename "$img")"
        continue
    fi

    lum=$(magick "$img" -colorspace gray -format '%[fx:mean]' info: 2>/dev/null)
    busy=$(magick "$img" -colorspace gray -resize 800x -edge 1 -threshold 25% \
        -format '%[fx:mean]' info: 2>/dev/null)

    # Force 8-bit up front: a Q16 ImageMagick prints histogram values in the
    # *source* depth, so 16-bit PNGs would report 0-65535 here.
    magick "$img" -depth 8 -resize 400x -colors 8 -depth 8 -format %c histogram:info:- 2>/dev/null |
        # The trailing .* matters: without it sed leaves the rest of the line
        # (",255) #... srgba(...)") attached to the last field.
        sed -nE 's/^ *([0-9]+): \(([0-9]+),([0-9]+),([0-9]+)[,)].*/\1 \2 \3 \4/p' |
        awk -v pal="$palette" -v lum="$lum" -v busy="$busy" \
            -v name="$(basename "$img")" '
        BEGIN {
            n = split(pal, p, " ")
            for (i = 1; i <= n; i++) { split(p[i], c, ","); pr[i]=c[1]; pg[i]=c[2]; pb[i]=c[3] }
            tot=0; wsum=0; near=0; chrsum=0; maxcnt=0
        }
        {
            cnt=$1; r=$2; g=$3; b=$4
            # Belt and braces for any 16-bit stragglers (65535/255 = 257).
            if (r > 255 || g > 255 || b > 255) { r/=257; g/=257; b/=257 }
            best = 1e9
            for (i = 1; i <= n; i++) {
                dr = r-pr[i]; dg = g-pg[i]; db = b-pb[i]
                d = sqrt(dr*dr + dg*dg + db*db)
                if (d < best) best = d
            }
            mx = r; if (g > mx) mx = g; if (b > mx) mx = b
            mn = r; if (g < mn) mn = g; if (b < mn) mn = b
            chrsum += (mx - mn) * cnt
            tot += cnt; wsum += best * cnt
            if (cnt > maxcnt) maxcnt = cnt
            if (best <= 25) near += cnt
        }
        END {
            if (tot == 0) { printf "%-40s (no data)\n", name; exit }
            pct = 100.0 * near / tot
            mean = wsum / tot
            flat = 100.0 * maxcnt / tot
            chrm = chrsum / tot / 255.0
            if (lum + 0 <= 0.30)      mode = "dark"
            else if (lum + 0 >= 0.70) mode = "light"
            else                      mode = "mid (fights both)"
            printf "%-40s %5.2f %5.2f %6.3f %4.0f%% %4.0f%% %6.0f  %s\n", \
                name, lum, chrm, busy, flat, pct, mean, mode
        }'
done
