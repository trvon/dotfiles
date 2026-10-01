-- Shared light/dark detection + colorscheme application.
--
-- Sway's auto-theme.sh sets org.gnome.desktop.interface color-scheme
-- ("prefer-light" / "prefer-dark"), and Ghostty follows it via
-- `theme = light:Gruvbox Light,dark:Gruvbox Dark Hard`. We read the same
-- source so Neovim matches the terminal.
local M = {}

---@return "light"|"dark"
function M.system_background()
  local ok, out = pcall(vim.fn.system, {
    "gsettings",
    "get",
    "org.gnome.desktop.interface",
    "color-scheme",
  })
  if ok and type(out) == "string" and out:find("prefer%-dark") then
    return "dark"
  end
  return "light"
end

---Repaint the colorscheme for the current vim.o.background.
---
---gruvbox.nvim takes a single `contrast` value, but Ghostty runs
---"Gruvbox Dark Hard" and plain "Gruvbox Light". Setting contrast per reload
---(rather than once via plugin `opts`) makes both modes match the terminal.
---`setup()` resets to the plugin defaults before merging, so passing only
---`contrast` here does not drop anything else.
function M.apply_colorscheme()
  local gruvbox = require("gruvbox")
  gruvbox.setup({
    contrast = vim.o.background == "dark" and "hard" or "",
  })
  gruvbox.load()
end

---Sync vim.o.background with the system preference.
---@param on_change? fun(bg: "light"|"dark") called only when the value changed
function M.sync(on_change)
  local bg = M.system_background()
  if vim.o.background ~= bg then
    vim.o.background = bg
    if on_change then
      on_change(bg)
    end
  end
end

return M
