# @Author: Elrey and Blackmanta
#!/bin/bash

# Fancy Colors
red='\e[1;31m'
blue='\e[1;34m'
white='\e[1;37m'

# Function for backing up system
function backup {
	# Set maximum for backup's PER directory
	MAX=5
	
	# Backups sorted in folders by month
	DAY=$(date -d "$D" '+%d')
	MONTH=$(date + '%B' | cut -c 1-3)
	YEAR=$(date -d "$D" '+%Y')
	
	
	# Checks for Root
	if [ "$EUID" -ne 0 ]; then
		USER=whoami
	else
		USER=$SUDO_USER
	fi
	
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
		ls | awk -F- '{print $3}' | sort | sed -n 1p | xargs -I {} rm -fr *${}* 
	fi
	
	sudo rsync -aAXv --exclude={"/dev/*","/proc/*","/sys/*","/tmp/*","/run/*","/mnt/*","/media/*","/lost+found","/home/$USER/.cache/*","/mnt/"} / $BACKUP_FILE > $LOG
	sudo tar czvf $BACKUP_FILE.tgz $BACKUP_FILE >> $LOG
	sudo rm -rf $BACKUP_FILE
	sudo sha256sum $BACKUP_FILE > $BACKUPFILE.hash
}

# Will need to store hashes in a smart manner for checking
function restore {
	echo -e $white "Not implemented"
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
