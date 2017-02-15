# Only Admin can run
command -v rkhunter 2>&1 || 
{ 
	echo >&2 "rkhunter is required to install, would you like to? (y/n)";
	read answer
	if [$answer == 'y']; then 
		echo "installing"
        dnf install rkhunter
	else 
		exit 1
	fi
}
# rkhunter --check

