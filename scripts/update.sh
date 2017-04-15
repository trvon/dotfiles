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
	
	if [ -d ~/.config/sublime-text-3 ] ; then
		cp -r ~/.config/sublime-text-3 ../res
	fi
}

# restores saved configs in res
function restore {
	
	for i in res/*
	do 	
		base='.'$(basename "${i}")
		cp -r $i ~/$base
	done
	
	which vim  > /dev/null	
	if [ $? -ne 0 ] ; then
		echo -e "Install Vim you nub!\n"
		sudo pacman -S vim 
	fi
	# rm -fr ~/.vim/bundle/*
	git clone https://github.com/VundleVim/Vundle.vim ~/.vim/bundle/Vundle.vim
	vim +PluginInstall +qall
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
