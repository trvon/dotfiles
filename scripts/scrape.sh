# This script goes through all folders in the home directory

function scrape {
for i in ~/* 
	do
		if[ -d "$i"] ; then 
			touch -
			for i in ./*
				do
					scrape
				done
		fi
	done
}


