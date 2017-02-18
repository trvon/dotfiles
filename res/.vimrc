
" Created by Trevon Williams

" Editor Enviroment

set nocompatible 
syntax on 
filetype off

set rtp+=~/.vim/bundle/Vundle.vim

call vundle#begin()

Plugin 'VundleVim/Vundle.vim'
Plugin 'tpope/vim-fugitive'
Plugin 'L9'
Plugin 'rstacruz/sparkup', {'rtp': 'vim/'}
Plugin 'scrooloose/nerdtree'
Plugin 'kien/ctrlp.vim'
Plugin 'flazz/vim-colorschemes'
Plugin 'vim-scripts/Vim-JDE'
Plugin 'artur-shaik/vim-javacomplete2'
Plugin 'davidhalter/jedi-vim'
Plugin 'ervandew/supertab'
Plugin 'vim-scripts/indentpython.vim'
Plugin 'Lokaltog/powerline', {'rtp': 'powerline/bindings/vim'}
call vundle#end()

filetype plugin indent on

set hlsearch
set ignorecase
set smartcase
colors CandyPaper
set t_Co=256
set number
set tabstop=4

" Plugin Configurations 

" Jedi-Vim 
"
let g:jedi#use_tabs_not_buffers=1
let g:jedi#popup_select_first=0

"
" Vim Powerline
let g:Powerline_symbols='fancy'
