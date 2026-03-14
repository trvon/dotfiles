# Dotfiles

Personal configuration and local tooling.

This repo is the source of truth for the machine-specific config I keep in sync
manually. There is no bootstrap script. Each area has its own focused docs where
needed.

## Layout

- `linux/` - desktop shell, WM, bar, notification, and terminal config
- `bsd/` - BSD-specific config
- `windows/` - Windows notes and config
- `pi/` - Pi agent config, extensions, models, and tests
- `openclaw/` - OpenClaw Docker image, compose setup, and local plugins
- `SERVER.md` - small server/admin notes

## Main docs

- [pi/README.md](/Users/trevon/Documents/depend/dotfiles/pi/README.md) - Pi setup and extension behavior
- [openclaw/README.md](/Users/trevon/Documents/depend/dotfiles/openclaw/README.md) - OpenClaw container setup
- [openclaw/extensions/pi-context/README.md](/Users/trevon/Documents/depend/dotfiles/openclaw/extensions/pi-context/README.md) - Pi-style OpenClaw plugin
- [windows/README.md](/Users/trevon/Documents/depend/dotfiles/windows/README.md) - Windows notes

## Notes

- Vim/Neovim is managed separately with LazyVim.
- Most changes are copied into place or mounted directly rather than installed by script.
- AI-agent-related config lives under `pi/` and `openclaw/`; the rest is normal system dotfiles.
