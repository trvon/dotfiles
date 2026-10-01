-- Autocmds are automatically loaded on the VeryLazy event
-- Default autocmds that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/autocmds.lua
--
-- Add any additional autocmds here
-- with `vim.api.nvim_create_autocmd`
--
-- Or remove existing autocmds by their group name (which is prefixed with `lazyvim_` for the defaults)
-- e.g. vim.api.nvim_del_augroup_by_name("lazyvim_wrap_spell")

-- Re-check the system light/dark preference when Neovim regains focus, so
-- toggling the theme (sway auto-theme.sh) updates the colorscheme live instead
-- of requiring a restart.
vim.api.nvim_create_autocmd({ "FocusGained", "VimResume" }, {
  group = vim.api.nvim_create_augroup("user_theme_sync", { clear = true }),
  callback = function()
    require("config.theme").sync(require("config.theme").apply_colorscheme)
  end,
})
