#!/bin/bash
wget -O splunkforwarder-7.0.3-fa31da744b51-linux-2.6-amd64.deb 'https://www.splunk.com/bin/splunk/DownloadActivityServlet?architecture=x86_64&platform=linux&version=7.0.3&product=universalforwarder&filename=splunkforwarder-7.0.3-fa31da744b51-linux-2.6-amd64.deb&wget=true'
rpm -i splunkforwarder-7.0.3-fa31da744b51-linux-2.6-amd64.deb
/opt/splunkforwarder/bin/splunk edit user admin -password 75aVUyfvVNpH6OCYU9Lq! -auth admin:changeme
/opt/splunkforwarder/bin/splunk add forward-server 10.0.4.55:9998 -auth admin:75aVUyfvVNpH6OCYU9Lq!
/opt/splunkforwarder/bin/splunk add monitor /var/log/ -auth admin:75aVUyfvVNpH6OCYU9Lq! 
/opt/splunkforwarder/bin/splunk enable boot-start
/opt/splunkforwarder/bin/splunk restart
yum install -y ufw python34 rkhunter
rm /usr/bin/python
ln -s /usr/bin/python3 /usr/bin/python
ufw allow 22
ufw allow 80
ufw block 8000
ufw status numbered