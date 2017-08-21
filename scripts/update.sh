# This will backup your dotfiles

#backs up configs to res folder
function backup {
	for i in ~/.*
	do
		if [ -f $i ]; then
			file=$(basename "${i}" | sed 's/.//' )
	 		if [[ $file == "bash_"* ]] || [ $file == esd_auth ] || 
					[[ $file == "zcompdump"* ]] || [[ $file == "viminfo"* ]] || 
					[[ $file == "Xa"*  ]]; then
					continue
			fi
			cp $i ../dotfiles/$file
		fi	
	done
	
	# Can add check for them later
	cp -r ~/.config/polybar ../dotfiles/
	cp -r ~/.config/i3 ../dotfiles/
	cp -r ~/.config/dunst ../dotfiles/
	# Need my fonts
	cp -r ~/.local/share/fonts/ ../dotfiles

	# if [ -d ~/.config/sublime-text-3 ] ; then
	# 	cp -r ~/.config/sublime-text-3 ../res
	# fi
}

# Bash_it
function bash_install {
	git clone --depth=1 https://github.com/Bash-it/bash-it.git ~/.bash_it
	sh ~/.bash_it/install.sh
}	

# restores saved configs in res
function restore {
	for i in ../dotfiles/*
	do 	
		# Copies files to home
		if [ -f $1 ]; then 
			base='.'$(basename "${i}")
			cp $i ~/$base
		fi
	done
	
	# which vim  > /dev/null	
	# if [ $? -ne 0 ] ; then
	# 	echo -e "Install Vim you nub!\n"
	#	sudo pacman -S vim 
	# fi
	# rm -fr ~/.vim/bundle/*
	if [ ! -d ~/.vim/bundle ]; then
        	mkdir -p ~/.vim/bundle
		git clone https://github.com/VundleVim/Vundle.vim ~/.vim/bundle/Vundle.vim
    	fi
	vim +PluginInstall +qall
	
	# Bash-it
	echo "Would you like to install bash-it? (Y/n)"
	read prompt
	case "$prompt" in 
		y|Y) bash_install ;;
		*) echo "Proceeding ..."
	esac


	# Copy directories
	# For configs
	if [ ! -d ~/.config ]; then
		mkdir ~/.config
	fi
	# For founts
	if [ ! -d ~/.local/share ]; then
		mkdir -p ~/.local/share
	fi
	
	# May need a better way of restoring when my things are backed up
	cp -r ../dotfiles/polybar ~/.config
	cp -r ../dotfiles/i3 ~/.config
	cp -r ../dotfiles/dunst ~/.config
}


while [ 1 == 1 ]
do
	echo "Do you want to backup or restore your configs? (r/b)"
	read P
	case "$P" in 
		"r") restore && break ;;
		"b") backup && break ;;
		#"n") echo "Okey :)" && break ;;
		*) echo "try again" ;;
	esac
done	

echo "Finished :)"

