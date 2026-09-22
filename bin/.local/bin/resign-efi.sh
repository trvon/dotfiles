#!/usr/bin/env bash
# ~/.local/bin/resign-efi.sh
#
# Re-sign the EFI binaries on the ESP after they are replaced.
#
# The sbctl package already ships a pacman hook that does this automatically
# (/usr/share/libalpm/hooks/zz-sbctl.hook, which runs "sbctl sign-all -g" on
# any transaction touching usr/lib/**/efi/* or usr/lib/modules/*/vmlinuz).
#
# THE GAP THIS FILLS: ZFSBootMenu is hand-installed here, not owned by any
# package, so no pacman transaction ever fires for it. Update ZBM manually and
# forget this step, and the next reboot fails Secure Boot verification with no
# obvious warning.
#
# Run this immediately after replacing /efi/EFI/zbm/zfsbootmenu.EFI.
#
#   sudo ~/.local/bin/resign-efi.sh

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "error: needs root (sbctl reads its private keys)" >&2
    echo "usage: sudo $0" >&2
    exit 1
fi

if ! command -v sbctl >/dev/null; then
    echo "error: sbctl not found" >&2
    exit 1
fi

# Files that are NOT covered by the pacman hook (hand-installed) plus the
# fwupd stub for good measure. Signed with the db key, which is enrolled.
FILES=(
    /efi/EFI/zbm/zfsbootmenu.EFI
    /efi/EFI/arch/fwupdx64.efi
)

echo "== current state =="
sbctl status || true
echo

for f in "${FILES[@]}"; do
    if [ ! -f "$f" ]; then
        echo "  SKIP (absent): $f"
        continue
    fi
    # -s records the file in /var/lib/sbctl/files.json so 'sbctl sign-all'
    # keeps re-signing it after future package transactions.
    printf '  signing %s ... ' "$f"
    sbctl sign -s "$f" >/dev/null
    echo "ok"
done

echo
echo "== verification (this is the part that matters) =="
if sbctl verify; then
    echo
    echo "All tracked EFI binaries verify. Safe to reboot."
else
    echo
    echo "FAILED: something on the ESP is unsigned or signed with an untrusted key." >&2
    echo "Do NOT reboot with Secure Boot enabled until this passes." >&2
    exit 1
fi
