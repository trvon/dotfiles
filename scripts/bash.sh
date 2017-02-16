# Need to echo out all that this script adds to system
function goinstall {
	# May need to update with current GO version 
	GO=1.7.5
	GOHTML='https://storage.googleapis.com/golang/go$GO.linux-amd64.tar.gz'
	echo "Downloading Go Version $GO"
	wget -P ~/Depend -qe --progress=bar $GOHTML
	GOPLACE="$(ls ~/Depend | grep go)"
	echo $GOPLACE
	tar -C /usr/local -xzf ~/Depend/$GOPLACE
	rm -fr ~/Depend/$GOPLACE
	exit
}

function meta {
	# Pretty heavy metaspoit install
	git clone https://github.com/rapid7/metasploit-framework
	# RVM install
	curl -sSL https://rvm.io/mpapis.asc | gpg --import -
	curl -o rvm.sh -L https://get.rvm.io
	less rvm.sh # Read it and see it's all good
	cat rvm.sh | bash -s stable && clear
	cd ~/Depend/metasploit-framework
	# Ruby install
	rvm --install .ruby-version
	gem install bundler
	bundle install
}

clear && echo -e "\nWould you like to overwrite the  bashrc file? (y/n)"
read choice
if [ $choice == 'y' ]; then
	# For debugging
	if [ ! -d ~/Depend ]; then 
		mkdir ~/Depend
	fi
	cat ../configuration/bashrc > ~/.bashrc
	goinstall
	meta
	git clone -q https://github.com/nojhan/liquidprompt ~/Depend/
fi

exit;
