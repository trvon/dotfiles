# !/bin/bash
# Found base script online
pacman -Rscn $(pacman -Qtdp)
pacman -Sc
pacman-optimize && sync

exit 0
