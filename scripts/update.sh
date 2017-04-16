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
			cp $i ../res/$file
		fi	
	done
	
	# Can add check for them later
	cp -r ~/.config/polybar ../res/
	cp -r ~/.config/i3 ../res/
	cp -r ~/.config/dunst ../res/
	# Need my fonts
	cp -r ~/.local/share/fonts/ ../res

	# if [ -d ~/.config/sublime-text-3 ] ; then
	# 	cp -r ~/.config/sublime-text-3 ../res
	# fi
}

# restores saved configs in res
function restore {
	
	for i in res/*
	do 	
		# Copies files to home
		if [ -f $1 ]; then 
			base='.'$(basename "${i}")
			cp -r $i ~/$base
		fi

	done
	
	which vim  > /dev/null	
	if [ $? -ne 0 ] ; then
		echo -e "Install Vim you nub!\n"
		sudo pacman -S vim 
	fi
	# rm -fr ~/.vim/bundle/*
	git clone https://github.com/VundleVim/Vundle.vim ~/.vim/bundle/Vundle.vim
	vim +PluginInstall +qall
	
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
	cp -r ../res/polybar ~/.config
	cp -r ../res/i3 ~/.config
	cp -r ../res/dunst ~/.config
	cp -r ../res/fonts ~/.local/share/
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
