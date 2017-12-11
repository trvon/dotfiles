#!/bin/bash

# Set maximum for backup's PER directory
MAX=5

# Backups sorted in folders by month
DAY=$(date -d "$D" '+%d')
MONTH=$(date -d "$D" '+%m')
MONTH=$(($MONTH - 1))
YEAR=$(date -d "$D" '+%Y')

MONTHS=(Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec)

# Backup directory
BACKUP_DIR=/run/media/blck/backups

# File name for backups
BACKUP_FILE="${MONTHS[$MONTH]}"-$YEAR
# echo $BACKUP_FILE 

# Checks if directory has more backups than MAX limit
COUNT=$(ls $BACKUP_DIR/${MONTHS[$MONTH]} | wc -l)

DIR=$BACKUP_DIR/${MONTHS[$MONTH]}
cd $DIR

# Remove olders dir based on year

## This is dump logic and probally should be edited when backups
## are needed to be removed
if [ "$COUNT" -gt "$MAX" ]; then
		ls | awk -F- '{print $2}' | sort | sed -n 1p | xargs -I {} rm -fr ${MONTHS[$MONTH]}
fi

## Use if needed
# gpg --full-generate-key

# Add other directories if needed for backup
# sudo tar -cJf $BACKUP_FILE.tar.xz /home/$(whoami) /usr /opt /usr
