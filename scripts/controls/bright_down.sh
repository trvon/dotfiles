bright=$(cat /sys/class/backlight/intel_backlight/brightness)
if (( $bright > 0 )); then
	let bright=$bright-100
	echo "echo $bright > /sys/class/backlight/intel_backlight/brightness" | sudo bash
fi	
