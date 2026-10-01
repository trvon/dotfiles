-- LSP tweaks on top of LazyVim's defaults.
--
-- clangd is routed through mason by default (`mason = true`). For mason-managed
-- servers LazyVim does NOT call `vim.lsp.enable`; it defers to
-- `mason-lspconfig`'s automatic_enable, which only enables servers mason itself
-- installed. With only the distro clangd present (/usr/bin/clangd, from the
-- Arch `clang` package) the server therefore never started, and no C/C++ LSP
-- client attached.
--
-- Setting `mason = false` makes LazyVim call `vim.lsp.enable("clangd")` and use
-- the system binary via the `cmd` from the lang.clangd extra, so we also avoid
-- a second clangd download under ~/.local/share/nvim/mason.
return {
  {
    "neovim/nvim-lspconfig",
    opts = {
      servers = {
        clangd = { mason = false },
      },
    },
  },
}
