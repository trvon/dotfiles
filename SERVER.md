# Server Notes

## LXD and Docker on the same host

If Docker traffic breaks LXD networking, allow `lxdbr0` through `DOCKER-USER`.

Reference:
https://discuss.linuxcontainers.org/t/lxd-losts-iptables-rules-with-docker/15045

```bash
sudo iptables -I DOCKER-USER -i lxdbr0 -j ACCEPT
sudo iptables -I DOCKER-USER -o lxdbr0 -j ACCEPT
```
