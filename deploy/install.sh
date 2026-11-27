#!/bin/sh
# Installs uketsugi for the person running it. No sudo, and no Node: the release carries its own
# runtime, and a Node already on this machine is neither used nor touched.
#
#   sh install.sh [--tarball <file or URL>] [--sha256 <hex>]
#
# The release is unpacked into ~/.local/lib/uketsugi and a `ukt` command is put in ~/.local/bin;
# nothing else is written. UKT_LIB_DIR and UKT_BIN_DIR move the two. The tarball's SHA-256 is
# checked before anything is unpacked: against --sha256 or UKT_SHA256, else the value this copy
# of the script was built with, else the `.sha256` file beside the tarball. Run over an earlier
# release it replaces it and keeps that one at <lib>.previous; a server that runs as the person's
# service (`ukt setup` installs one) is started again on the new release, and if it does not
# answer, the earlier release is put back (`ukt upgrade --settle`, below). `ukt rollback` goes back
# after an upgrade that went well.
set -eu

# Set by deploy/build.sh in the copy that ships with a release.
BUILT_TARBALL=""
BUILT_SHA256=""
BUILT_URL=""
BUILT_SIZE=""

fail() {
  printf 'install.sh: %s\n' "$1" >&2
  printf 'Nothing was installed. %s\n' "$2" >&2
  exit 1
}

# After the swap the service is the business of a `ukt` that knows how it is run: this release's, or
# where this release predates the verb (a release put back over a newer one), the release it
# replaced, which has it. Where neither has, nothing here can restart or check the service, and
# the script says so instead of claiming it did.
settle() {
  lib=$1
  # A release that has the verb lists it; asking it to run the verb would end well enough on one that has not.
  if "$lib/bin/ukt" --help 2>&1 | grep -q '^  upgrade '; then settler=$lib/bin/ukt
  elif "$lib.previous/bin/ukt" --help 2>&1 | grep -q '^  upgrade '; then settler=$lib.previous/bin/ukt
  else
    printf 'Neither release can restart or check your service. If it is running, restart it: systemctl --user restart uketsugi\n'
    return 0
  fi
  "$settler" upgrade --settle "$lib"
}

# Everything below runs from one function, called on the script's last line: a download of this
# script that was cut short defines half a function and runs nothing.
main() {
tarball=${UKT_TARBALL:-}
expected=${UKT_SHA256:-}
while [ $# -gt 0 ]; do
  case "$1" in
    --tarball) tarball=${2:?--tarball needs a file or a URL}; shift 2 ;;
    --sha256) expected=${2:?--sha256 needs a value}; shift 2 ;;
    -h | --help) sed -n '2,13s/^# \{0,1\}//p' "$0"; exit 0 ;;
    *) fail "unknown argument: $1" "Run it as: sh install.sh [--tarball <file or URL>] [--sha256 <hex>]" ;;
  esac
done

[ -n "${HOME:-}" ] || fail "HOME is not set." "Set HOME, or set UKT_LIB_DIR and UKT_BIN_DIR."
lib=${UKT_LIB_DIR:-$HOME/.local/lib/uketsugi}
bin=${UKT_BIN_DIR:-$HOME/.local/bin}

machine="$(uname -s)-$(uname -m)"
[ "$machine" = "Linux-x86_64" ] || fail "this release is built for Linux on x86-64, and this machine is $machine." \
  "A machine whose harness uses a uketsugi server elsewhere needs no install: add that server's URL to the harness."

here=$(CDPATH='' cd -- "$(dirname -- "$0")" 2>/dev/null && pwd -P) || here=""
if [ -z "$tarball" ] && [ -n "$BUILT_TARBALL" ]; then
  if [ -n "$here" ] && [ -f "$here/$BUILT_TARBALL" ]; then
    tarball="$here/$BUILT_TARBALL"
  elif [ -n "$BUILT_URL" ]; then
    tarball="$BUILT_URL/$BUILT_TARBALL"
  fi
fi
if [ -z "$tarball" ] && [ -n "$BUILT_TARBALL" ]; then
  # A copy made by a build that was not told where its files would be served: it finds its
  # release only beside itself, which a script read from a pipe never is.
  fail "this copy of the install script was built without the address of its release, so it cannot fetch it." \
    "Put $BUILT_TARBALL in the folder this script is in and run it from there, or pass --tarball <file or URL>."
fi
[ -n "$tarball" ] || fail "no release was named." "Pass --tarball <file or URL>."

# Everything is prepared beside the target, so the last step is a rename and a failure leaves no half install.
mkdir -p "$(dirname -- "$lib")" "$bin"
work="$lib.installing.$$"
trap 'rm -rf "$work"' EXIT
mkdir "$work"

# Fetches $1 to the file $2: a URL with curl or wget, a path by copying. With "shown" as $3 a
# download draws its progress where a person is watching, so a slow line does not look hung.
fetch() {
  case "$1" in
    http://* | https://*)
      if command -v curl >/dev/null 2>&1; then
        if [ "${3:-}" = shown ] && [ -t 2 ]; then
          curl -fL --progress-bar -o "$2" "$1"
        else
          curl -fsSL -o "$2" "$1"
        fi
      elif command -v wget >/dev/null 2>&1; then
        wget -q -O "$2" "$1"
      else
        fail "neither curl nor wget is on this machine." "Install one, or download the release and pass --tarball <file>."
      fi
      ;;
    *) cp -- "$1" "$2" ;;
  esac
}

case "$tarball" in
  http://* | https://*) printf 'Downloading uketsugi%s from %s\n' "${BUILT_SIZE:+ ($BUILT_SIZE)}" "$tarball" >&2 ;;
esac
fetch "$tarball" "$work/release.tar.gz" shown || fail "the release could not be fetched from $tarball." "Check the path or the network and run the script again."

if [ -z "$expected" ]; then expected=$BUILT_SHA256; fi
if [ -z "$expected" ]; then
  fetch "$tarball.sha256" "$work/release.sha256" 2>/dev/null ||
    fail "there is no SHA-256 to check the release against." "Pass --sha256 <hex>, or put the release's .sha256 file beside it."
  read -r expected _ <"$work/release.sha256" || true
fi

if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$work/release.tar.gz")
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$work/release.tar.gz")
else
  fail "neither sha256sum nor shasum is on this machine." "Install coreutils so the release can be checked."
fi
actual=${actual%% *}
[ "$actual" = "$expected" ] || fail "the release does not have the expected SHA-256 (expected $expected, found $actual)." \
  "The file is damaged or is not the release this script was made for. Download it again."

mkdir "$work/unpacked"
tar -xzf "$work/release.tar.gz" -C "$work/unpacked" || fail "the release could not be unpacked." "Check that tar and gzip are installed and the disk is not full."
set -- "$work/unpacked"/*
[ $# -eq 1 ] && [ -x "$1/bin/ukt" ] || fail "the tarball is not a uketsugi release." "Download the release again."
release=$1

version=$("$release/bin/ukt" --version 2>&1) || fail "the runtime in the release does not run on this machine: $version" \
  "It needs Linux on x86-64 with glibc 2.28 or newer."

upgrade=no
if [ -e "$lib" ]; then
  upgrade=yes
  was=$(sed -n '1s/^uketsugi //p' "$lib/VERSION" 2>/dev/null || true)
  printf 'Upgrading uketsugi %s to %s in %s.\n' "${was:-(unknown version)}" "$version" "$lib"
  printf 'The release you have is kept at %s.previous. If your service (uketsugi.service) is this install'"'"'s and running, it is restarted on the new release, and\n' "$lib"
  printf 'if its server does not answer, the release you have is put back and started again.\n'
  mv -- "$lib" "$work/previous"
fi
if ! mv -- "$release" "$lib"; then
  if [ -e "$work/previous" ]; then mv -- "$work/previous" "$lib"; fi
  fail "the release could not be moved to $lib." "Check that the directory can be written."
fi
# The release it replaced is kept one deep, for `ukt rollback` and for a start that fails.
if [ "$upgrade" = yes ]; then
  rm -rf -- "$lib.previous"
  mv -- "$work/previous" "$lib.previous"
fi

quoted=$(printf '%s' "$lib/bin/ukt" | sed "s/'/'\\\\''/g")
printf '#!/bin/sh\nexec '\''%s'\'' "$@"\n' "$quoted" >"$bin/ukt.$$"
chmod 755 "$bin/ukt.$$"
mv -f -- "$bin/ukt.$$" "$bin/ukt"

if [ "$upgrade" = yes ]; then
  # A new release whose server does not start is put back by this, and the script ends there.
  settle "$lib" || { printf 'Nothing was installed: the release you had is the one that runs.\n' >&2; exit 1; }
fi
printf 'Installed uketsugi %s in %s\n' "$version" "$lib"
printf 'The command is %s\n' "$bin/ukt"
if [ "$upgrade" = yes ]; then printf '`ukt doctor` checks that everything is in order.\n'; fi
case ":${PATH:-}:" in
  *":$bin:"*) if [ "$upgrade" = no ]; then printf '\nNext: ukt setup\n'; fi ;;
  *)
    # The file a new shell of the person's kind reads when it starts.
    shell=${SHELL:-}
    case "${shell##*/}" in
      zsh) startup="$HOME/.zshrc" ;;
      bash) startup="$HOME/.bashrc" ;;
      *) startup="$HOME/.profile" ;;
    esac
    printf '\n%s is not on your PATH. Add it for this shell:\n' "$bin"
    printf '  export PATH="%s:$PATH"\n' "$bin"
    printf 'and for new ones:\n'
    printf '  echo '\''export PATH="%s:$PATH"'\'' >> %s\n' "$bin" "$startup"
    if [ "$upgrade" = no ]; then printf '\nNext: ukt setup   (or now: %s setup)\n' "$bin/ukt"; fi
    ;;
esac
}

main "$@"
