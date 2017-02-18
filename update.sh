# These updates data files for back up
# If you are using the script, please use a repository for 
# the backing up of your dotfiles

for i in ~/.*
do
	if [ -f $i ]; then
		file=$(basename "${i}")
		# Use sed according to the files you would like t
		# Store
		file=$(echo $file | sed 's/.//')
	 	cp $i res/$file
	fi	
done

echo "Finished :)"
