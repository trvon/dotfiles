# This will backup your dotfiles

#backs up configs to res folder
function backup {
	for i in ~/.*
	do
		if [ -f $i ]; then
			file=$(basename "${i}" | sed 's/.//' )
	 		cp $i res/$file
		fi	
	done
	cp -r ~/.config/polybar ../res/
	cp -r ~/.config/i3 ../res/
}

# restores saved configs in res
function restore {
	for i in res/*
	do 	
		base='.'$(basename "${i}")
		cp $i ~/$base
	done
}


while [ 1 == 1 ]
do
	echo "Do you want to backup or restore your configs? (r/b/n)"
	read P
	case "$P" in 
		"r") restore && break ;;
		"b") backup && break ;;
		"n") echo "Okey :)" && break ;;
		*) echo "try again" ;;
	esac
done	

echo "Finished :)"
