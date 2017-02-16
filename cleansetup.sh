# Script for setting up enviroment in new linux distro 
# Created by Trvon
clear &&  echo -e "\nWelcome, do you need to set up your user info?(y/n)\n\tex. Username & Email"
read run && clear
sudo echo -e "\nWhat package manager are you using?\n\n\t(1) Fedora\n\t(2) Debian\n\t(3) Arch"
read pac && clear
#  Sets the package manager variable
case "$pac" in 
	"1")
			P="dnf"
			;;
	"2")
			P="apt-get"
			;;
	"3")
			P="pacman"
			;;
	*)
			echo "Not an option."
			exit 1
			;;
esac

# Uses these variables for all intitializations
if [ $pac == 'y' ]; then
	echo -e "\nWhat is you haxer name?"
	read name
	echo -e "What is your primary email"
	read email
fi

clear
# VIM setup
command -v vim >/dev/null 2>&1 || 
{
	echo  -e "\nVim not installed, Installing...\n"
	$P install vim -y;
}
cat configuration/vimrc > ~/.vimrc

clear
#  Git setting up Git
command -v git >/dev/null 2>&1 || 
{
	echo -e "\nGit is not installed, Installing...\n"
	$P install git -y;
}
if [ ! -f ~/.gitconfig ] ; then
	echo -e "\nSetting up github...\n"
	git config --global user.name $name
	git config --global user.email $email
fi

clear
# Starts RSA with 4096  Process
if [ ! -f ~/.ssh/id_rsa.pub ]; then
	ssh-keygen -t rsa -b 4096
	ssh-add
fi

clear
# bash initialization with resources
echo -e "\nWould you like to set up the bashrc with its dependencies? (y/n)"
read run 
if [ $run == 'y' ] ; then
	sh scripts/bash.sh
fi
clear

echo -e "\nAll setup configurations are complete, enjoy linux :)\n"
