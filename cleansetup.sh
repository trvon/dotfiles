# Script for setting up enviroment in new linux distro 
# Created by Trvon

echo $P

sudo echo -e "\nWhat package manager are you using?\n(1) Fedora\n(2) Debian\n(3) Arch\n"
read pac

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

echo -e "\nWhat is you haxer name?"
read name
echo -e "What is your primary email"
read email


command -v vim >/dev/null 2>&1 || 
{
	echo  -e "\nVim not installed, Installing...\n"
	$P install vim -y;
}

cat configs/vimrc > ~/.vimrc

command -v git >/dev/null 2>&1 || 
{
	echo -e "\nGit is not installed, Installing...\n"
	$P install git -y;
}

#  Git setting up Git
if [ ! -f ~/.gitconfig ] ; then
	echo -e "\nSetting up github...\n"
	git config --global user.email $name
	git config --global user.name $email
fi

# Starts RSA Process
if [ ! -f ~/.ssh/id_rsa.pub ]; then
	ssh-keygen -t rsa -b 4096
fi
