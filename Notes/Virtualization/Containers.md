# Containers Notes
*This is incomplete*

## Goal
The goal of this note repository is to create a compository to help guide learning and research into container technologies.

## Linux Containers
- [cgroup v1 - spec](https://www.kernel.org/doc/Documentation/cgroup-v1/)
- [cgroup v2 - spec](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html)
- [cgroups package for Go](https://github.com/containerd/cgroups)
- [Understanding the Docker Internals](https://medium.com/@BeNitinAgarwal/understanding-the-docker-internals-7ccb052ce9fe)
- [Docker interals: process isolation with namespaces and cgroups](https://leftasexercise.com/2018/04/12/docker-internals-process-isolation-with-namespaces-and-cgroups/)
- [The Seccomp Notifier - New Frontiers in Unpriviledged Container Developement](https://people.kernel.org/brauner/the-seccomp-notifier-new-frontiers-in-unprivileged-container-development)

## BSD Containers

### Runtime
[runC](https://opensource.com/life/16/8/runc-little-container-engine-could) is an runtime contianer similar to docker that follows an (OCI) open container initiative defined by multiple entities.

### Containerd
[Containerd deep dive](https://www.youtube.com/watch?v=4f_2u6rIDTk)

### OS Layer

## Appendix

### Attacking the Kernel and Friends
- [Evil eBPF](https://media.defcon.org/DEF%20CON%2027/DEF%20CON%2027%20presentations/DEFCON-27-Jeff-Dileo-Evil-eBPF-In-Depth.pdf)

### Research Papers
- [A Defense Method against Docker Escape Attack](https://dl.acm.org/doi/pdf/10.1145/3058060.3058085?download=true)
- [Analysis of Security in Modern Container Platforms](https://link.springer.com/content/pdf/10.1007%2F978-981-10-5026-8_14.pdf)
