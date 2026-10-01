# Wallpapers

One file per set, mode and size:

```text
wallpapers/<set>-<mode>-<W>x<H>.<ext>
```

## Sets

**`mountains`**

- light — *Cloudy Mountains* (Chinese ink landscape, The Met, **CC0**), lifted into
  the light band. `lum 0.72  busy 0.008  fit 100%` — the calmest image here.
- dark — sunrise over **Palmer Park, Colorado Springs** by mark byzewski
  (**CC BY 2.0**). `lum 0.23  busy 0.046  fit 69%`.

**`fish`**

- light — *Medetai Fish and Sasaki Bamboo*, from the series *Uozukushi* (ukiyo-e
  print, The Met, **CC0**). `lum 0.73  busy 0.073  fit 86%`.
- dark — lionfish at Shark Reef Aquarium by Holiday Point (**CC BY 2.0**).
  `lum 0.28  busy 0.051  fit 95%`.

## Sizes

- `1920x1200` — all four files.
- `2560x1600` and `3840x2400` — the two **dark** files only.

Sizes are capped by the source resolution, deliberately: the two light sources are
museum scans of 2220x954 and 1945x1339, so 2560- or 3840-wide versions would be
1.3-2.5x upscaled fake detail. Adding a size is just another file with the
resolution in the name. Sizes are per-set rather than uniform, which is why the
picker enumerates what exists instead of assuming a ladder.

## How the file is chosen

`scripts/wallpaper-lib.sh` (sourced by `auto-theme.sh` and `wallpaper-cycle.sh`):

- **Size** — the smallest stored size that still covers the screen, else the
  largest available, so an oversized display scales rather than refusing.
  Verified: `1920 -> 1920`, `2560 -> 2560`, `3840 -> 3840`, `5120 -> 3840`.
- **Resolution** — largest *active* output from `swaymsg -t get_outputs`, falling
  back to 1920x1200 when sway cannot be queried.
- **Mode** — `.theme-mode` (written by `auto-theme.sh`).
- **Set** — `.wallpaper-set`, so the set survives theme changes and reloads.
  Verified: `use fish`, toggle to dark -> still `fish`, now `fish-dark-1920x1200`.
  Cycling updates it too, so a later theme change shows the same set.

`wp_apply` copies the file to `~/.config/sway/wallpaper.png` (the static path
`lock.sh` and `swayidle` read, so the lockscreen matches), repaints sway, and
mirrors the choice into `gsettings picture-uri`/`picture-uri-dark` so
`watch-wallpaper.sh` agrees instead of fighting.

## Cycling — `$mod+Shift+b`

An *entry* is a set x mode pair, so each wallpaper is shown once even though it
is stored in several sizes (the size is chosen for the output). Entries for the
current mode come first, then the other mode's, flagged in the notification —
otherwise the dark images would be unreachable without also toggling the theme,
which defeats the point of a preview key.

```sh
~/.config/sway/scripts/wallpaper-cycle.sh next            # next entry, wraps
~/.config/sway/scripts/wallpaper-cycle.sh prev
~/.config/sway/scripts/wallpaper-cycle.sh list            # all entries, applied one marked *
~/.config/sway/scripts/wallpaper-cycle.sh use mountains   # set, current mode's file
~/.config/sway/scripts/wallpaper-cycle.sh apply /tmp/x.jpg  # preview one image
```

## Licences

CC0 requires nothing; **CC BY 2.0 requires attribution**, which is what this
section is for — keep it if you redistribute these files.

- Cloudy Mountains — https://commons.wikimedia.org/wiki/File:Cloudy_Mountains_MET_DP212993.jpg (CC0)
- Medetai Fish and Sasaki Bamboo — https://commons.wikimedia.org/wiki/File:-Medetai_Fush_and_Sasaki_Bamboo,_from_the_series_Uozukushi_(Every_Variety_of_Fish)_MET_DP123587.jpg (CC0)
- Palmer Park Sunrise 024 — https://commons.wikimedia.org/wiki/File:2024-08-18_Palmer_Park_Sunrise_024.jpg (CC BY 2.0, mark byzewski)
- Shark Reef Aquarium lionfish — https://commons.wikimedia.org/wiki/File:Shark_Reef_Aquarium,_Mandalay_Bay,_Las_Vegas_-_8133530582.jpg (CC BY 2.0, Holiday Point)

## Choosing a wallpaper

`scripts/wallpaper-fit.sh <image>` scores a candidate on the things that decide
whether it works *behind tiled windows* — you mostly see slivers through 11px
gaps under a top bar, not the whole picture.

- **`lum`** mean luminance. Dark mode wants <= 0.30, light mode >= 0.70. A
  mid-tone (~0.4-0.6) image is worse than either extreme: it matches neither the
  bar nor the window chrome, so it looks foreign in both modes.
- **`chrm`** mean chroma, i.e. how far from grey the average pixel is. Use this,
  **not** HSL/HSV saturation, which lies at the extremes of lightness: gruvbox
  cream `#fbf1c7` reports saturation 0.87 while obviously being muted, whereas
  chroma gets it right at 0.20 (magenta is 1.00).
- **`busy`** share of pixels an edge filter fires on. High-frequency detail
  (foliage, gravel, crowds, brick) becomes noise when 90% of it is hidden. Under
  ~0.02 is calm; over ~0.08 is a texture, not a backdrop.
- **`flat`** share of area taken by the single most common colour. A calm
  backdrop usually has one dominant surface — sky, mist, water.
- **`fit`** share of pixels already within 25 RGB units of a gruvbox colour, plus
  the mean distance to the nearest. Low fit means retint it or it will read as a
  foreign object.

### Final score table

```text
image                    lum  chrm   busy  flat   fit meanD  verdict
mountains-light          0.72  0.10  0.008   44%  100%    19  light   <- calmest image here
fish-light               0.73  0.28  0.073   51%   86%    25  light
fish-dark                0.28  0.05  0.052   39%   95%    15  dark
mountains-dark           0.23  0.07  0.046   48%   69%    22  dark
```

### The finding worth knowing: real photographs cannot be light-mode wallpapers

The `light >= 0.70` rule is only reachable with flat, high-key artwork. Measured:

```text
best landscape photo found    0.66   but busy 0.479 (a texture)
snow / winter scenes          0.44-0.56
sky-dominant crops            0.31-0.51
gamma lift 3.0 on a photo     0.65   while fit collapsed 70% -> 37%
gamma 2.0 on the ink painting 0.72   fit stayed 100%
```

Brightening a photograph does not fix it: at the lift needed, the palette fit
collapses, so you get a washed-out image that also clashes. The painting lifts
cleanly (0.54 -> 0.72, fit 100%) because its material is flat. So the working
split is **light mode = artwork/illustration, dark mode = photographs.** If you
would rather have photographs in light mode too, relax the band to `>= 0.55` and
accept that the bar will be brighter than the wallpaper.

### Metrics narrow the field; eyes decide

The scores are a filter, not a verdict. `Fish Tank, Blue Reef Aquarium` scored
respectably (`flat 57%`) but is a photograph of an aquarium *as a room* —
signage, structural beams, visitors — which no metric flagged.

### Sanity checks

Feeding raw gruvbox colours should reproduce this exactly; it is a good way to
confirm the parser has not regressed:

```text
#1d2021 dark0_hard     0.12  0.02  fit 100%  meanD 0
#fbf1c7 light0         0.94  0.20  fit 100%  meanD 0
#fabd2f bright_yellow  0.75  0.80  fit 100%  meanD 0
#ff00ff magenta        0.28  1.00  fit   0%  meanD 173
```
