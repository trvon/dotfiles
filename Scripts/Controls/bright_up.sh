max=$(cat /sys/class/backlight/intel_backlight/max_brightness)
bright=$(cat /sys/class/backlight/intel_backlight/brightness)

if (( $bright < $max )); then
	let bright=$bright+100
	echo "echo $bright > /sys/class/backlight/intel_backlight/brightness" | sudo bash
fi

	
