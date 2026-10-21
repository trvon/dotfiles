# Sourced by every zsh (including scripts) -- keep it to environment only.
# Interactive setup (keychain, nvm, aliases, prompt) lives in ~/.zshrc.

# Secrets (API keys, tokens) -- untracked, chmod 600
[[ -r "$HOME/.config/zsh/secrets.zsh" ]] && source "$HOME/.config/zsh/secrets.zsh"

typeset -U path PATH
path=(
    "$HOME/.local/bin"
    "$HOME/.opencode/bin"
    "$HOME/.grok/bin"
    $path
    "$HOME/go/bin"
    "$HOME/Documents/depend/flutter/bin"
)

export GOPATH="$HOME/go"

# --- Build output lives off the snapshotted dataset --------------------------
# ~/.local/share/build is the zroot/home/build dataset: compression=zstd-9 and
# com.sun:auto-snapshot=false, so build churn is never pinned by sanoid
# snapshots. In-repo ./build trees ARE snapshotted, and that is what grew
# zroot/home to 286G of snapshots once already.
#
# Nothing here exports a build output directory. CARGO_TARGET_DIR is tempting
# but poisonous machine-wide: a build system that runs `cargo build` and then
# reads <src>/target - YAMS's libsql Meson wrap does exactly that - fails
# after a successful compile. All three tools take the directory per
# invocation instead:
#   cbuild [cmake args]   -> cmake -S $PWD -B $BUILD_ROOT/<repo>-<hash>
#   mbuild [meson args]   -> meson setup $BUILD_ROOT/<repo>-<hash> $PWD
#   rbuild [cargo args]   -> cargo <args> --target-dir $BUILD_ROOT/<repo>-<hash>/cargo-target
#
# If a rebuild fails with "failed to create directory ~/.local/share/build/..."
# check `stat -c %U ~/.local/share/build`: freshly created ZFS datasets mount
# root-owned and need a one-time `sudo chown $USER: ~/.local/share/build`.
export BUILD_ROOT="${BUILD_ROOT:-$HOME/.local/share/build}"


# Node: put the newest nvm-installed node on PATH without sourcing nvm.sh
# (nvm alias default is "stable"). `nvm` itself is lazy-loaded in ~/.zshrc.
export NVM_DIR="$HOME/.nvm"
nvm_bin=( "$NVM_DIR"/versions/node/*/bin(Nn[-1]) )
(( $#nvm_bin )) && path=("$nvm_bin[1]" $path)
unset nvm_bin

# Rust
[[ -f "$HOME/.cargo/env" ]] && source "$HOME/.cargo/env"
