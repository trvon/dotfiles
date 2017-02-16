# Need to echo out all that this script adds to system
function goinstall {
	# May need to update with current GO version 
	GO=1.7.5
	GOHTML='https://storage.googleapis.com/golang/go$GO.linux-amd64.tar.gz'
	echo "Downloading Go Version $GO"
	wget -P ~/Depend -nc -qe --progress=bar $GOHTML
	GOPLACE=$(ls ~/Depend | grep go)
	tar -C /usr/local -xzf ~/Depend/$GOPLACE
	rm -fr ~/Depend/$GOPLACE
	exit
}

if [ ! -d ~/Depend ]; then
	mkdir ~/Depend
fi

clear && echo -e "\nWould you like to install golang? (y/n)"
read choice
if [ $choice == 'y' ]; then 
	goinstall
fi

clear && echo -e "\nWould you like to add liquidprompt appearance modification? (y/n)"
read choice
if [ $choice == 'y' ]; then
	command -v git >/dev/null 2>&1 || { echo "Git hasn't been installed"; exit; }
	git clone -q https://github.com/nojhan/liquidprompt ~/Depend/
fi

