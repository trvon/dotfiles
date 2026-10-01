-- Options are automatically loaded before lazy.nvim startup
-- Default options that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/options.lua
-- Add any additional options here

-- Soft wrap by default (LazyVim sets vim.opt.wrap = false).
vim.opt.wrap = true
vim.opt.linebreak = true
vim.opt.breakindent = true
vim.opt.showbreak = "↳ "
vim.opt.breakindentopt = "shift:2,min:20"

-- Start in the same light/dark mode as the rest of the desktop.
-- config.theme also re-checks this on focus (see autocmds.lua).
vim.o.background = require("config.theme").system_background()
