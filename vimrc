" Created by trvon

set nocompatible 
syntax on
set encoding=utf-8
filetype plugin indent on
set rtp+=~/.vim/bundle/Vundle.vim

call vundle#begin()

Plugin 'VundleVim/Vundle.vim'
Plugin 'tpope/vim-fugitive'
Plugin 'L9'
Plugin 'kien/ctrlp.vim'
Plugin 'flazz/vim-colorschemes'
Plugin 'davidhalter/jedi-vim'
Plugin 'preservim/nerdtree'
Plugin 'ervandew/supertab'
Plugin 'fatih/vim-go'
Plugin 'hashivim/vim-terraform'

call vundle#end()

filetype plugin indent on

set hlsearch
set ignorecase
set smartcase
colors CandyPaper
set t_Co=256
set number relativenumber 
set tabstop=4

" Jedi-Vim 
let g:jedi#use_tabs_not_buffers=1
let g:jedi#popup_select_first=0

" Terraform
let g:terraform_align=1
let g:terraform_fmt_on_save=1
let g:terraform_fold_sections=1

" NerdTree settings
map <C-t> :NERDTreeToggle<CR>
