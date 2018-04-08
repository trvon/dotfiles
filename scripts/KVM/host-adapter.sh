#!/bin/bash

# This script creates an host-only adapter for my KVM VM's
ip link add name windows-host type bridge
ip addr add 172.20.0.1/16 dev windows-host
ip link set windows-host up
dnsmasq --interface=windows-host --bind-interfaces --dhcp-range=172.20.0.2,172.20.0.254
