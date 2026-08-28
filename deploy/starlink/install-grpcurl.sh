#!/bin/sh
set -eu

version='1.9.3'
archive="grpcurl_${version}_linux_arm64.tar.gz"
expected_sha256='b20a00c1cb82ab81ec32696766d4076e99b4cb5ca0823a71767ba64dbea0f263'
download_url="https://github.com/fullstorydev/grpcurl/releases/download/v${version}/${archive}"
work_dir="$(mktemp -d /tmp/laba-grpcurl.XXXXXX)"

cleanup() {
  rm -rf -- "$work_dir"
}
trap cleanup EXIT HUP INT TERM

curl --fail --location --proto '=https' --tlsv1.2 --output "$work_dir/$archive" "$download_url"
actual_sha256="$(sha256sum "$work_dir/$archive" | cut -d ' ' -f 1)"
if [ "$actual_sha256" != "$expected_sha256" ]; then
  echo 'grpcurl checksum mismatch' >&2
  exit 1
fi

tar -xzf "$work_dir/$archive" -C "$work_dir" grpcurl
install -d -o root -g root -m 0755 /usr/local/lib/laba-starlink
install -o root -g root -m 0755 "$work_dir/grpcurl" /usr/local/lib/laba-starlink/grpcurl
/usr/local/lib/laba-starlink/grpcurl -version
