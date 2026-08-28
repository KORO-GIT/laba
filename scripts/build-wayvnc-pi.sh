#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script as root: sudo $0 $*" >&2
  exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
patch_file=${1:-"$script_dir/../deploy/desktop/wayvnc-power-unknown.patch"}
source_base='https://archive.raspberrypi.com/debian/pool/main/w/wayvnc'
build_dir=$(mktemp -d /tmp/laba-wayvnc-build.XXXXXX)

cleanup() {
  rm -rf -- "$build_dir"
}
trap cleanup EXIT HUP INT TERM

test -f "$patch_file"

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install --yes \
  build-essential ca-certificates dpkg-dev gnutls-dev libaml-dev libdrm-dev \
  libjansson-dev libneatvnc-dev libpam0g-dev libpixman-1-dev \
  libsystemd-dev libturbojpeg0-dev libwayland-dev libxkbcommon-dev \
  meson ninja-build patch pkgconf scdoc wget xz-utils zlib1g-dev

cd "$build_dir"
wget --quiet \
  "$source_base/wayvnc_0.9.1.orig.tar.gz" \
  "$source_base/wayvnc_0.9.1-1+rpt5.debian.tar.xz" \
  "$source_base/wayvnc_0.9.1-1+rpt5.dsc"

sha256sum --check <<'CHECKSUMS'
aaaca02d36e54ec6ecf457dc266251946d895ac91521fbabb3470c3c09b3753c  wayvnc_0.9.1.orig.tar.gz
ad3e12bac82e0466fccb1a9316f989111e888d6ec5f4d6bc54c01905aa5fb635  wayvnc_0.9.1-1+rpt5.debian.tar.xz
6112a03371c54b7bb354ffa5222510380094d15d18ece2a76717fb373a0fc97d  wayvnc_0.9.1-1+rpt5.dsc
CHECKSUMS

dpkg-source -x wayvnc_0.9.1-1+rpt5.dsc
cd wayvnc-0.9.1
patch --batch --forward -p1 < "$patch_file"
meson setup build --buildtype=release -Dtests=false -Dman-pages=disabled \
  -Dpam=enabled -Dscreencopy-dmabuf=enabled
meson compile -C build

install -d -o root -g root -m 0755 /usr/local/lib/laba
install -o root -g root -m 0755 build/wayvnc /usr/local/lib/laba/wayvnc
/usr/local/lib/laba/wayvnc --version
