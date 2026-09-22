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

# Node: put the newest nvm-installed node on PATH without sourcing nvm.sh
# (nvm alias default is "stable"). `nvm` itself is lazy-loaded in ~/.zshrc.
export NVM_DIR="$HOME/.nvm"
nvm_bin=( "$NVM_DIR"/versions/node/*/bin(Nn[-1]) )
(( $#nvm_bin )) && path=("$nvm_bin[1]" $path)
unset nvm_bin

# Rust
[[ -f "$HOME/.cargo/env" ]] && source "$HOME/.cargo/env"
