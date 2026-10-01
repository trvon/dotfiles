-- Colorscheme: gruvbox.nvim, matching the Ghostty theme
-- (`light:Gruvbox Light,dark:Gruvbox Dark Hard`).
--
-- config.theme.apply_colorscheme() repaints for the current vim.o.background,
-- which config.theme.sync keeps in line with the system light/dark preference
-- set by sway's auto-theme.sh. Using a function instead of the `"gruvbox"`
-- string is what lets the contrast differ per mode (hard when dark, plain when
-- light).
return {
  {
    "LazyVim/LazyVim",
    opts = {
      colorscheme = function()
        require("config.theme").apply_colorscheme()
      end,
    },
  },

  {
    "ellisonleao/gruvbox.nvim",
    lazy = false,
    priority = 1000,
  },
}
