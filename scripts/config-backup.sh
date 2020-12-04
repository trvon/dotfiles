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
			cp -r $i ../dotfiles/$file
		fi	
	done
}

# Bash_it
function bash_install {
	git clone --depth=1 https://github.com/Bash-it/bash-it.git ~/.bash_it
	sh ~/.bash_it/install.sh
}	

# restores saved configs in res
function restore {
	# For configs
	if [ ! -d ~/.config ]; then
		mkdir ~/.config
	fi
	
	# Copies configs	
	for i in ../dotfiles/*
	do 	
		# Copies files to home
		if [ -f $1 ]; then 
			base='.'$(basename "${i}")
			cp $i ~/$base
		elif [ -d $1 ]; then
			cp -r $i ~/.config
		fi
	done
	
	# Need to include an OS check that install's programs
	# using local package manager
	if [ ! -d ~/.vim/bundle ]; then
        	mkdir -p ~/.vim/bundle
		git clone https://github.com/VundleVim/Vundle.vim ~/.vim/bundle/Vundle.vim
    	fi
	vim +PluginInstall +qall
	
	# Bash-it
	echo "Would you like to install bash-it? (Y/n)"
	read -t 5 prompt
	case "$prompt" in 
		y|Y) bash_install ;;
		*) echo "Proceeding ..." && exit ;;
	esac
}


while [ 1 == 1 ]
do
	echo "Do you want to backup or restore your configs? (r/b)"
	read P
	case "$P" in 
		"r") restore && break ;;
		"b") backup && break ;;
		*) echo "try again" ;;
	esac
done	

echo "Finished :)"
