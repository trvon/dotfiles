# --- Zsh History Configuration ---
HISTFILE=~/.zsh_history
HISTSIZE=50000
SAVEHIST=50000

# History Options
setopt HIST_IGNORE_ALL_DUPS  # Don't record duplicates
setopt HIST_REDUCE_BLANKS    # Remove superfluous blanks
setopt HIST_IGNORE_SPACE     # Leading space keeps a command out of history
setopt HIST_VERIFY           # Expand !! into the buffer instead of running it
setopt EXTENDED_HISTORY      # Record timestamps and durations
setopt SHARE_HISTORY         # Share history across sessions (implies incremental append)

# --- SSH / GPG agent (keychain 3.x) ---
# Fast path: reuse the running agent; only call keychain (and warm the GPG
# signing key) when the SSH key isn't loaded yet, e.g. first shell after login.
export GPG_TTY=$TTY
if command -v keychain &>/dev/null; then
    [[ -r "$HOME/.keychain/${HOST}-sh" ]] && source "$HOME/.keychain/${HOST}-sh"
    if ! ssh-add -l &>/dev/null; then
        eval "$(keychain add --eval --quiet --immediate \
            id_ed25519 gpgs:D66F93E5DAD777C373A0CB13083EB1C25C575E81)"
    fi
fi

# --- Completion ---
fpath=(~/.grok/completions/zsh $fpath)
autoload -Uz compinit
# Full security check at most once a day; otherwise use the cached dump.
if [[ -n ~/.zcompdump(#qN.mh+24) ]]; then
    compinit
else
    compinit -C
fi
[[ ~/.zcompdump.zwc -nt ~/.zcompdump ]] || zcompile ~/.zcompdump

# --- Node (nvm) ---
# node/npm/pi are already on PATH via ~/.zshenv; load nvm.sh only when needed.
nvm() {
    unfunction nvm
    source "$NVM_DIR/nvm.sh"
    nvm "$@"
}

# --- Starship, Zoxide, and FZF Integration ---
# Set up fzf key bindings and fuzzy completion
if command -v fzf &>/dev/null; then
    if fzf --zsh &>/dev/null; then
        source <(fzf --zsh)
    fi
fi

# Set up zoxide to move between folders efficiently (oxide)
if command -v zoxide &>/dev/null; then
    eval "$(zoxide init zsh)"
fi

# Set up the Starship prompt
if command -v starship &>/dev/null; then
    eval "$(starship init zsh)"
fi

# atopile (VS Code extension's uv env)
[[ -f "$HOME/.config/Code/User/globalStorage/atopile.atopile/uv/env" ]] && \
    source "$HOME/.config/Code/User/globalStorage/atopile.atopile/uv/env"

# --- Helper Functions ---
# ex: universal archive extractor
function ex() {
    if [ -f "$1" ] ; then
        case "$1" in
            *.tar.bz2)   tar xjf "$1"   ;;
            *.tar.gz)    tar xzf "$1"   ;;
            *.bz2)       bunzip2 "$1"   ;;
            *.rar)       unrar x "$1"   ;;
            *.gz)        gunzip "$1"    ;;
            *.tar)       tar xf "$1"    ;;
            *.tbz2)      tar xjf "$1"   ;;
            *.tgz)       tar xzf "$1"   ;;
            *.zip)       unzip "$1"     ;;
            *.Z)         uncompress "$1";;
            *.7z)        7z x "$1"      ;;
            *.deb)       ar x "$1"      ;;
            *.tar.xz)    tar xf "$1"    ;;
            *.tar.zst)   unzstd "$1"    ;;
            *)           echo "'$1' cannot be extracted via ex()" ;;
        esac
    else
        echo "'$1' is not a valid file"
    fi
}

# --- Aliases & Modern Replacements ---
UNAME_OS="$(uname)"
OS_ID=""
[[ -r /etc/os-release ]] && OS_ID="$(. /etc/os-release; echo "$ID $ID_LIKE")"

# Modern ls replacement (eza) with standard fallback
if command -v eza &>/dev/null; then
    alias ls="eza --color=always --long --git --icons --group-directories-first"
    alias la="eza --color=always --long --all --git --icons --group-directories-first"
else
    if [ "$UNAME_OS" = "Linux" ]; then
        alias ls="ls -lAh --color=auto"
    elif [ "$UNAME_OS" = "OpenBSD" ]; then
        alias ls="colorls -lah -G"
    else
        alias ls="ls -la"
    fi
fi

# Modern cat replacement (bat/batcat)
if command -v batcat &>/dev/null; then
    alias cat="batcat --style=plain --paging=never"
elif command -v bat &>/dev/null; then
    alias cat="bat --style=plain --paging=never"
fi

# fd is packaged as fdfind on Debian/Ubuntu
if command -v fdfind &>/dev/null; then
    alias fd="fdfind"
fi

# Git and lazygit
if command -v lazygit &>/dev/null; then
    alias lg="lazygit"
fi
alias gs="git status"
alias gd="git diff"
alias gp="git pull"
alias gpf="git push"

# Package manager shortcuts (Debian/Ubuntu vs Arch)
if [[ "$OS_ID" == *debian* ]] || [[ "$OS_ID" == *ubuntu* ]]; then
    alias grab="sudo apt-get install -y"
    alias purge="sudo apt purge -y"
    alias remove="sudo apt autoremove -y"
    alias update="sudo apt update -y"
    alias upgrade="sudo apt upgrade -y"
    alias search="apt search"
elif [[ "$OS_ID" == *arch* ]]; then
    alias grab="sudo pacman -S"
    alias purge="sudo pacman -Rns"
    alias remove="sudo pacman -Rns \$(pacman -Qdtq)"  # orphans
    alias update="sudo pacman -Syu"
    alias upgrade="sudo pacman -Syu"
    alias search="pacman -Ss"
fi

# General utilities
alias l="ls"
alias ..="cd .."
alias cp="cp -i"
alias df="df -h"
alias mv="mv -i"
alias p="upower --dump | grep 'percentage\|state' | sort | uniq"
alias rm="printf 'stop using rm... use tp/tl/te instead...\n'; false"
alias te="trash-empty"
alias tl="trash-list"
alias tp="trash-put"
alias when="history | grep"
alias vim="nvim"
command -v binwalk &>/dev/null && alias binwalk="binwalk --run-as=root"
command -v qemu-aarch64-static &>/dev/null && alias aarch64="qemu-aarch64-static -L /usr/aarch64-linux-gnu/"

# Kitty aliases
if command -v kitty &>/dev/null; then
    alias icat="kitty +kitten icat"
    alias kssh="kitty +kitten ssh"
fi

# --- Zsh Plugins (installed via package manager) ---
# Sourced last: syntax-highlighting must wrap all other widgets.
if [ -f /usr/share/zsh/plugins/zsh-autosuggestions/zsh-autosuggestions.zsh ]; then
    source /usr/share/zsh/plugins/zsh-autosuggestions/zsh-autosuggestions.zsh
elif [ -f /usr/share/zsh-autosuggestions/zsh-autosuggestions.zsh ]; then
    source /usr/share/zsh-autosuggestions/zsh-autosuggestions.zsh
fi

if [ -f /usr/share/zsh/plugins/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh ]; then
    source /usr/share/zsh/plugins/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh
elif [ -f /usr/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh ]; then
    source /usr/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh
fi
