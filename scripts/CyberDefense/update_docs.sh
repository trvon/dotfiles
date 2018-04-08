#!/bin/bash
for i in $(ls /home)
do 
	# echo $i
	cp documentation.pdf $i
	chown $i:$i $i/documentation.pdf
done
