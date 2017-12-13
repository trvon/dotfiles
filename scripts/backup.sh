#!/bin/bash

# Set maximum for backup's PER directory
MAX=5

# Backups sorted in folders by month
DAY=$(date -d "$D" '+%d')
MONTH=$(date -d "$D" '+%m')
MONTH=$(($MONTH - 1))
YEAR=$(date -d "$D" '+%Y')

MONTHS=(Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec)

# Checks for Root
if [ "$EUID" -ne 0 ]; then
	USER=whoami
else
	USER=$SUDO_USER
fi

# Backup directory
BACKUP_DIR=/run/media/blck/backups

# File name for backups
BACKUP_FILE=$DAY-"${MONTHS[$MONTH]}"-$YEAR

# Checks if directory has more backups than MAX limit
COUNT=$(ls $BACKUP_DIR/${MONTHS[$MONTH]} | wc -l)

DIR=$BACKUP_DIR/${MONTHS[$MONTH]}
cd $DIR

# Logging for files
LOG=$DIR/$BACKUP_FILE.log
if [ ! -f $LOG ]; then
	touch $LOG
fi

# Remove olders dir based on year
## This is dump logic and probally should be edited when backups
## are needed to be removed
if [ "$COUNT" -gt "$MAX" ]; then
	ls | awk -F- '{print $3}' | sort | sed -n 1p | xargs -I {} rm -fr ${MONTHS[$MONTH]}
fi

## Use if needed
# gpg --full-generate-key

sudo rsync -aAXv --exclude={"/dev/*","/proc/*","/sys/*","/tmp/*","/run/*","/mnt/*","/media/*","/lost+found","/home/$USER/.cache/*","/mnt/"} / $BACKUP_FILE > $LOG
sudo tar czvf ${BACKUP_FILE}.tgz $BACKUP_FILE >> $LOG
sudo rm -rf $BACKUP_FILE