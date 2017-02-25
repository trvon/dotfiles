# Only Admin can run
command -v rkhunter 2>&1 || 
{ 
	echo >&2 "rkhunter is required to install, would you like to? (y/n)";
	read answer
	if [$answer == 'y']; then 
		echo "installing"
        # dnf install rkhunter
		# Need to add check for package managers
	else 
		exit 1
	fi
}
# rkhunter --check

