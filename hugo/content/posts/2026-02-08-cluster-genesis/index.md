---
title: "Day One: Bootstrapping a k3s Cluster with Terraform and Ansible"
date: 2026-02-08T21:00:00-06:00
draft: false
author: "zolty"
description: "From bare Proxmox hosts to a fully operational k3s HA cluster in a single day, using Terraform for VM provisioning and Ansible for configuration management."
tags: ["k3s", "terraform", "ansible", "kubernetes", "proxmox", "homelab"]
categories: ["Infrastructure"]
cover:
  image: "/images/covers/infrastructure.svg"
  alt: "Cluster bootstrapping"
  hidden: false
ShowToc: true
TocOpen: false
---

## TL;DR

Today was cluster genesis. Starting from 3 bare Proxmox hosts, I built the entire infrastructure-as-code pipeline: Terraform to provision VMs from cloud-init templates, Ansible to configure and bootstrap k3s, and a full GitOps deployment model with SOPS-encrypted secrets and S3-backed Terraform state. By end of day: 3 server nodes, 3 agent nodes, cert-manager with Route53 DNS-01 validation, and self-hosted GitHub Actions runners on the cluster itself.

![Two Lenovo ThinkCentre M920q mini PCs with cases open, revealing Noctua CPU coolers — the workhorses of this cluster](m920q-internals.jpg)

## The Architecture

The design goal was simple: everything as code, nothing manual, everything reproducible.

```
┌─────────────────────────────────────────────────────┐
│                    Proxmox Cluster                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │  pve-1   │  │  pve-2   │  │  pve-3   │          │
│  │ M920q    │  │ M920q    │  │ M920q    │          │
│  │ i5-8500T │  │ i5-8500T │  │ i5-8500T │          │
│  │ 32GB     │  │ 32GB     │  │ 32GB     │          │
│  └──────────┘  └──────────┘  └──────────┘          │
│       │              │              │                │
│  ┌─────────┐  ┌─────────┐  ┌──────────┐            │
│  │server-1 │  │server-2 │  │server-3  │ Control    │
│  │4c/8GB   │  │4c/8GB   │  │4c/8GB    │ Plane      │
│  └─────────┘  └─────────┘  └──────────┘            │
│  ┌─────────┐  ┌─────────┐  ┌──────────┐            │
│  │agent-1  │  │agent-2  │  │agent-3   │ Workers    │
│  │6c/12GB  │  │6c/12GB  │  │6c/12GB   │            │
│  └─────────┘  └─────────┘  └──────────┘            │
└─────────────────────────────────────────────────────┘
```

Each physical host is a {{< amzn search="Lenovo ThinkCentre M920q" >}}Lenovo ThinkCentre M920q{{< /amzn >}} with an Intel i5-8500T and 32GB of DDR4 RAM — compact, quiet, and power-efficient enough to run 24/7 in a basement.

![The M920q cluster nodes racked up with active Noctua cooling fans](m920q-rack.jpg)

## Phase 1: Cloud-Init VM Template

Before Terraform can create VMs, Proxmox needs a template. I created a Debian 13 (Trixie) cloud-init template on the first node:

```bash
# Download Debian 13 cloud image
cd /var/lib/vz/template/iso
wget https://cloud.debian.org/images/cloud/trixie/daily/latest/debian-13-generic-amd64-daily.qcow2

# Create and configure template VM (ID 9000)
qm create 9000 --name debian-13-template --memory 2048 --net0 virtio,bridge=vmbr0
qm importdisk 9000 debian-13-generic-amd64-daily.qcow2 local-lvm
qm set 9000 --scsihw virtio-scsi-pci --scsi0 local-lvm:vm-9000-disk-0
qm set 9000 --ide2 local-lvm:cloudinit
qm set 9000 --boot c --bootdisk scsi0
qm set 9000 --agent enabled=1 --cpu host --ostype l26
qm resize 9000 scsi0 +30G
qm template 9000
```

Cloud-init is the key enabler here. It lets Terraform inject SSH keys, network configuration, and hostname at VM creation time — no manual setup per node.

## Phase 2: Terraform VM Provisioning

The Terraform configuration uses the `bpg/proxmox` provider to create VMs from the template. Each VM gets:

- Static IP via cloud-init
- SSH public key injection
- QEMU guest agent enabled
- Configurable CPU, memory, and disk sizes

The k3s server nodes get 4 cores and 8GB RAM for the control plane. The agent nodes get 6 cores and 12GB for running workloads. All nodes use a 32GB NVMe boot disk.

Network layout:

| Node | IP | Role |
|------|----|------|
| k3s-server-1 | 192.168.20.20 | Control plane + etcd |
| k3s-server-2 | 192.168.20.21 | Control plane + etcd |
| k3s-server-3 | 192.168.20.22 | Control plane + etcd |
| k3s-agent-1 | 192.168.20.30 | Worker |
| k3s-agent-2 | 192.168.20.31 | Worker |
| k3s-agent-3 | 192.168.20.32 | Worker |

```bash
terraform init
terraform plan    # 18 resources to create
terraform apply   # ~5 minutes to provision all VMs
```

Terraform also manages the S3 backend for state, using an encrypted S3 bucket with DynamoDB locking. No local state files to lose.

## Phase 3: Ansible Configuration

With VMs provisioned, Ansible takes over. The `site.yml` playbook runs through several roles in order:

1. **common**: Install packages, configure kernel modules (br_netfilter, overlay), set sysctl parameters for Kubernetes networking
2. **hardening**: SSH hardening (disable password auth, root login), UFW firewall (allow k3s ports 6443, 10250, Flannel VXLAN 8472), fail2ban
3. **k3s_server**: Bootstrap the first server with `--cluster-init` for embedded etcd, then join additional servers
4. **k3s_agent**: Join worker nodes using the server token
5. **cluster_services**: Deploy MetalLB, Longhorn, cert-manager, and Traefik

The entire Ansible run takes about 8 minutes from start to a fully operational cluster:

```bash
ansible-playbook -i inventory/homelab playbooks/site.yml
```

## Phase 4: Core Services

Once k3s was running, I deployed the platform services:

### MetalLB (Bare-Metal Load Balancer)
MetalLB provides LoadBalancer-type services — something that cloud Kubernetes gets for free but bare-metal clusters need to provision themselves. I configured an IP pool from 192.168.20.200-220 for service external IPs.

### Longhorn (Distributed Storage)
Longhorn gives me replicated persistent volumes across nodes. Each volume gets 2 replicas by default, so losing a node does not lose data. This is critical — I am running PostgreSQL databases on the cluster and they need to survive node failures.

### cert-manager (TLS Automation)
cert-manager with a Route53 DNS-01 solver handles Let's Encrypt certificates automatically. Any Ingress resource with the right annotation gets a valid TLS certificate within seconds. No more manual cert management.

### Traefik (Ingress Controller)
k3s ships with Traefik as the default ingress controller. I kept it — it handles routing, TLS termination, and middleware (rate limiting, IP whitelisting) well enough for my use case.

## Phase 5: Self-Hosted CI/CD

The final piece was GitHub Actions Runner Controller (ARC). Instead of paying for GitHub-hosted runners or managing standalone VMs, I deployed ARC directly into the cluster:

```yaml
runs-on: [self-hosted, k3s, linux, amd64]
```

This was one of the more painful parts of the day. ARC has some sharp edges:

- **Labels**: The `labels` field in RunnerDeployment *replaces* the default labels entirely. If you set `labels: [k3s, linux, amd64]`, the `self-hosted` label disappears unless you explicitly include it.
- **RBAC**: The runner pod needs `escalate` and `bind` verbs in its ClusterRole to create RoleBindings for deployed applications. You cannot grant permissions you do not have.
- **Secrets**: Organization-level secrets did not propagate to the runners as expected. I moved to repository-level secrets.

By end of day, I had CI/CD running on the cluster itself — workflows push to GitHub, the self-hosted runners pick them up, build containers, and deploy to the same cluster they are running on.

## SOPS and Secret Management

All secrets in the repository are encrypted with SOPS using age keys. The encryption is transparent to the workflow:

```bash
# Encrypt
sops -e secrets.yaml > secrets.enc.yaml

# Decrypt (in CI or locally)
sops -d secrets.enc.yaml | kubectl apply -f -
```

This means the entire cluster configuration — including secrets — lives in Git. Full GitOps. I can nuke everything and rebuild from the repository.

## The State of Things

End of day 1 stats:

- **6 VMs** running across 3 Proxmox hosts
- **3 control plane nodes** with embedded etcd for HA
- **3 worker nodes** ready for application workloads
- **Terraform state** backed by S3 with DynamoDB locking
- **SOPS-encrypted secrets** in Git
- **Self-hosted CI/CD** via ARC on the cluster
- **Automated TLS** via cert-manager + Route53
- **Distributed storage** via Longhorn with 2x replication

Total time from bare Proxmox hosts to fully operational cluster: about 12 hours, including all the debugging.

![The homelab in its early days — networking gear and mini PCs taking shape on wooden framing in the basement](homelab-overview.jpg)

## Lessons Learned

1. **Embedded etcd is the way to go for homelab k3s.** External etcd adds complexity without much benefit at this scale. k3s with `--cluster-init` handles it cleanly.
2. **Cloud-init templates save enormous time.** Creating VMs manually is a one-time task. The template approach means Terraform can spin up or replace nodes in minutes.
3. **ARC label behavior is a gotcha.** Read the docs carefully on labels — it cost me an hour of debugging why my workflows were not being picked up.
4. **Put Terraform state in S3 from day one.** Local state files are a ticking time bomb. The S3 + DynamoDB backend is trivial to set up and prevents disasters.

Tomorrow: deploying actual applications. Time to make this cluster earn its keep.
