# @Author: Elrey and Blackmanta
#!/bin/bash

#################################################
# If running the script from a keybinding ex. i3
# backing up and restore currently looks like:
#
#   You'll need zenity to be able to run script
#   from key binding
#
# 	(backup)  ... exec ./backup.sh b
#   (restore) ... exec ./backup.sh r
#################################################

# Fancy Colors
red='\e[1;31m'
blue='\e[1;34m'
white='\e[1;37m'

# Checks for Root
if [ "$EUID" -ne 0 ]; then
	USER=$(whoami)
else
	USER=$SUDO_USER
fi

# If running as keybinding grabs password
if [ ! -z $1 ]; then 
	exist=$(command -v zenity)
	# Checks if zenity is installed
	if [ -z $exist ] ; then
		notify-send "Install zenity"
		exit 1
	fi
	
	# Adding so script can be added to a keybinding
	password=$(zenity --password)
	while : ; do
		notify-send "Wrong password entered... Try again!"
		password=$(zenity --password)
		status=$(echo $password | sudo -v)
	    if [ -z $status ] ; then
		   break
		fi	   
	done
# If running as script grabs password
else
	while : ; do
		echo "[sudo] password for $USER"
		read -s -t 5 password
	
		status=$(echo $password | sudo -v)
		if [ -z $status ] ; then
	   		break
		fi
	done	
fi

# Function for backing up system
function backup {
	# Set maximum for backup's PER directory
	MAX=5
	
	# Backups sorted in folders by month
	DAY=$(date -d "$D" '+%d')
	MONTH=$(date +'%B' | cut -c 1-3)
	YEAR=$(date -d "$D" '+%Y')
	
	
	
	# Backup directory
	BACKUP_DIR=/run/media/blck/backups
	
	# File name for backups
	BACKUP_FILE=$DAY-$MONTH-$YEAR
	
	# Checks if directory has more backups than MAX limit
	COUNT=$(ls $BACKUP_DIR/$MONTH | wc -l)
	
	DIR=$BACKUP_DIR/$MONTH
	cd $DIR
	
	# Logging for files
	LOG=$DIR/$BACKUP_FILE.log
	if [ ! -f $LOG ]; then
		touch $LOG
	fi
	
	## This is dump logic and probally should be edited when backups
	## are needed to be removed
	if [ "$COUNT" -gt "$MAX" ]; then
		ls | awk -F- '{print $3}' | sort | sed -n 1p | xargs -I {} rm -fr *{}* 
	fi
	
	notify-send "Starting Rsync..."	
	echo $password | sudo rsync -aAXv --exclude={"/dev/*","/proc/*","/sys/*","/tmp/*","/run/*","/mnt/*","/media/*","/lost+found","/home/$USER/.cache/*","/home/$USER/.mozilla/*"} / $BACKUP_FILE > $LOG
	notify-send "Compressing backup..."	
	echo $password | sudo tar czvf $BACKUP_FILE.tgz $BACKUP_FILE >> $LOG
	notify-send "Cleaning up..."	
	echo $password | sudo rm -rf $BACKUP_FILE
	echo $password | sudo sha256sum $BACKUP_FILE > $BACKUPFILE.hash
	
	# Just in case
	password="password"
}

# Will need to store hashes in a smart manner for checking
function restore {
	echo -e $white "Not implemented"
	# Select backup to restore from	
	# Checksum compare

}

if [ $1 -z ]; then
	echo -e "\n"
	echo -e $blue "############################################"
	echo -e $blue	"|  Would you like to restore from previous |"  
	echo -e $blue	"|  backup.tgz or backup current '/' build  |"
	echo -e	$red 	"|                  (B/r)                   |"
	echo -e $red   	"|         *Will backup by default*         |"
	echo -e $blue "############################################\n"
	read choice
else
	choice=$1
fi

case $choice in
	'r') restore ;;
	*) backup ;;
esac
