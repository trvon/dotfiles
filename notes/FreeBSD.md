# FreeBSD Sources
- [FreeBSD Bhyve Setup Node](https://kflu.github.io/2020/04/08/2020-04-08-freebsd-bhyve/)


## Config

CBSD
```
# cbsd initenv preseed file for rome host
# refer to the /usr/local/cbsd/share/initenv.conf
# for description.
#
nodeip="192.168.1.24"
jnameserver="9.9.9.9,149.112.112.112,2620:fe::fe,2620:fe::9"
nodeippool="10.0.0.0/16"
nat_enable="pf"
fbsdrepo="1"
zfsfeat="1"
parallel="5"
stable="0"
sqlreplica="1"
statsd_bhyve_enable="0"
statsd_jail_enable="0"
statsd_hoster_enable="0"
ipfw_enable="0"
nodename="rome"
racct="1"
natip="192.168.1.24"
initenv_modify_sudoers="0"
initenv_modify_rcconf_hostname=""
initenv_modify_rcconf_cbsd_workdir="1"
initenv_modify_rcconf_cbsd_enable="1"
initenv_modify_rcconf_rcshutdown_timeout="1"
initenv_modify_syctl_rcshutdown_timeout="1"
initenv_modify_rcconf_cbsdrsyncd_enable=""
initenv_modify_rcconf_cbsdrsyncd_flags=""
initenv_modify_cbsd_homedir="1"
workdir="/usr/jails"
```
