#!/bin/bash
# Runs INSIDE the board's root filesystem (chroot) during build-image.sh.
# Installs system packages, the AI Python environment and enables the services.
# The bridge files themselves were already copied in by build-image.sh.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive LC_ALL=C.UTF-8 LANG=C.UTF-8

log() { echo "[customize] $*"; }

# ---------------------------------------------------------------- packages
log "Installing system packages"
# Vendor images sometimes ship broken/unsigned extra repos; don't let them stop the build.
apt-get update -o Acquire::AllowInsecureRepositories=false || apt-get update || true
apt-get install -y --no-install-recommends \
  avahi-daemon libnss-mdns network-manager dnsmasq-base wpasupplicant iw rfkill wireless-regdb \
  sudo python3 python3-venv ca-certificates dosfstools fdisk e2fsprogs util-linux curl tzdata
# Optional, nice to have; ignore if the distro calls them differently.
apt-get install -y --no-install-recommends openssh-server || true

# ---------------------------------------------------------------- user & folders
if ! id ffbridge >/dev/null 2>&1; then
  log "Creating service user ffbridge"
  useradd --system --home-dir /var/lib/ffbridge --create-home --shell /usr/sbin/nologin ffbridge
fi
usermod -a -G video ffbridge 2>/dev/null || true
install -d -o ffbridge -g ffbridge -m 755 /var/lib/ffbridge
install -d -m 755 /var/lib/ffbridge-sys /ffsetup
chown -R root:root /opt/ffbridge
chmod 755 /opt/ffbridge/bin/pibridge

# ---------------------------------------------------------------- AI environment
log "Creating the AI Python environment"
python3 -m venv /opt/ffbridge/ai/venv
/opt/ffbridge/ai/venv/bin/pip install --no-cache-dir --upgrade pip
/opt/ffbridge/ai/venv/bin/pip install --no-cache-dir -r /opt/ffbridge/ai/requirements.txt
/opt/ffbridge/ai/venv/bin/python -c "import onnxruntime, numpy, PIL; print('onnxruntime', onnxruntime.__version__)"

# ---------------------------------------------------------------- SD-card settings drive
if ! grep -q 'LABEL=FFBRIDGE' /etc/fstab; then
  log "Adding the FFBRIDGE settings drive to /etc/fstab"
  echo 'LABEL=FFBRIDGE /ffsetup vfat defaults,nofail,uid=ffbridge,gid=ffbridge,fmask=0133,dmask=0022,flush,x-systemd.device-timeout=15s 0 0' >> /etc/fstab
fi

# ---------------------------------------------------------------- hostname / mDNS
echo ffbridge > /etc/hostname
if grep -q '^127\.0\.1\.1' /etc/hosts; then
  sed -i 's/^127\.0\.1\.1.*/127.0.1.1\tffbridge/' /etc/hosts
else
  printf '127.0.1.1\tffbridge\n' >> /etc/hosts
fi
# Use mDNS (.local) for name lookups too.
if grep -q '^hosts:' /etc/nsswitch.conf && ! grep -q mdns /etc/nsswitch.conf; then
  sed -i 's/^hosts:.*/hosts:          files mdns4_minimal [NOTFOUND=return] dns/' /etc/nsswitch.conf
fi

# ---------------------------------------------------------------- security defaults
# Vendor images ship well-known default passwords and SSH switched on. A rookie never needs
# them, so lock them; SSH can be enabled from ffbridge-config.txt with a personal password.
log "Locking default accounts and disabling SSH (enable it in ffbridge-config.txt)"
passwd -l root >/dev/null 2>&1 || true
for u in $(awk -F: '$3 >= 1000 && $3 < 60000 {print $1}' /etc/passwd); do
  [ "$u" = ffbridge ] || [ "$u" = ffadmin ] || passwd -l "$u" >/dev/null 2>&1 || true
done
systemctl disable ssh.service 2>/dev/null || true
systemctl disable sshd.service 2>/dev/null || true
# Skip Armbian's interactive first-login wizard (nobody logs in on this appliance).
rm -f /root/.not_logged_in_yet
# Getty autologin on the debug console of some vendor images: turn it off.
rm -f /etc/systemd/system/serial-getty@*.service.d/override.conf /etc/systemd/system/getty@tty1.service.d/override.conf 2>/dev/null || true

# ---------------------------------------------------------------- services
# Our firstboot service grows the root partition; vendor resizers would fight over it.
for s in armbian-resize-filesystem orangepi-resize-filesystem resize2fs_once rpi-resizefs; do
  systemctl disable "$s.service" 2>/dev/null || true
  systemctl mask "$s.service" 2>/dev/null || true
done
systemctl enable NetworkManager.service avahi-daemon.service || true
systemctl enable ffbridge-firstboot.service ffbridge-config.service ffbridge-hotspot.service ffai.service ffbridge.service
# A static/ifupdown wlan0 config would stop NetworkManager from managing Wi-Fi.
if [ -f /etc/network/interfaces ]; then
  sed -i -E '/^\s*(auto|allow-hotplug)\s+wlan[0-9]+/d; /^\s*iface\s+wlan[0-9]+/,/^\s*$/d' /etc/network/interfaces || true
fi

# ---------------------------------------------------------------- tidy up
apt-get clean
rm -rf /var/lib/apt/lists/* /root/.cache /tmp/* 2>/dev/null || true
# A fresh machine-id is generated on first boot (needed for unique DHCP/mDNS identity).
truncate -s 0 /etc/machine-id
rm -f /var/lib/dbus/machine-id
log "Done"
