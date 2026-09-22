# Global instructions

Environment: Arch Linux, sway (Wayland), zsh, tmux. Dotfiles live in
`~/Documents/depend/dotfiles` and are symlinked into `$HOME` with GNU stow --
edit the repo copy, not a file under `~/.config` directly.

- Prefer the project's own conventions, scripts and tooling over new ones.
- Never write secrets into tracked files. API keys live in
  `~/.config/zsh/secrets.zsh` (untracked); reference them as `$VAR` in config.
- Don't commit or push unless asked.
- `rm` is aliased to a refusal in interactive shells; use `trash-put` for
  user-facing deletes.
