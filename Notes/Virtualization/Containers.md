# Containers Notes
*This is incomplete*

## Goal
The goal of this note repository is to create a compository to help guide learning and research into container technologies.

## Linux Containers

When setting out to attack a container, we must first understand what a container is. This definition of a container begins to differ as you inspect the layers of abstractions of different technologies. For the sake of time, we focuse on the different between two technologies LXC/LXD and docker. At this point we found ourselves reading an archived article from flockport [Understanding the key differences between LXC and Docker](https://archives.flockport.com/lxc-vs-docker/). At this time of the writing of the article, we find that the main difference would be how each technology utilizies the implementation of [cgroups](https://en.wikipedia.org/wiki/Cgroups), a container resource manager built into the Linux Kernel. The cgroup wiki page we found had an extensive list of references, so we began to dive into a cgroup rabbit hole here. Hopefully the details below present a cohert representation of our findings.

- [cgroup v1 - spec](https://www.kernel.org/doc/Documentation/cgroup-v1/)
- [cgroup v2 - spec](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html)
- [cgroups package for Go](https://github.com/containerd/cgroups)

## BSD Containers

### Runtime
[runC](https://opensource.com/life/16/8/runc-little-container-engine-could) is an runtime contianer similar to docker that follows an (OCI) open container initiative defined by multiple entities.

### Containerd
[Containerd deep dive](https://www.youtube.com/watch?v=4f_2u6rIDTk)

### OS Layer

## Appendix
### Research Papers
- [A Defense Method against Docker Escape Attack](https://dl.acm.org/doi/pdf/10.1145/3058060.3058085?download=true)
- [Analysis of Security in Modern Container Platforms](https://link.springer.com/content/pdf/10.1007%2F978-981-10-5026-8_14.pdf)

### Other notable container technology
- [OpenVZ](https://openvz.org/)
