#!/usr/bin/env bash
# Builds the release for Linux on x86-64 into deploy/dist/:
#
#   uketsugi-<version>-linux-x64.tar.gz          the Node runtime found on this machine, the built
#                                                server with its production dependencies, the
#                                                dashboard's files, the plugins harnesses install,
#                                                the `ukt` launcher, and the LICENSE and NOTICE
#   uketsugi-<version>-linux-x64.tar.gz.sha256   its SHA-256, as `sha256sum` prints it
#   install.sh                                   deploy/install.sh with that name, SHA-256 and size set
#
# Usage: deploy/build.sh
# A release that people install with `curl …/install.sh | sh` must be built with UKT_RELEASE_URL
# set to the URL the three files are served under: the install script fetches the tarball from
# there. Built without it, install.sh installs only from a tarball beside it, and the build ends
# by saying so.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
out="$root/deploy/dist"

if [ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]; then
  echo "build.sh: this builds the linux-x64 release from the Node on this machine; this machine is $(uname -s)-$(uname -m)." >&2
  exit 1
fi

node_bin=$(node -p 'process.execPath')
node_version=$(node -p 'process.version')
version=$(node -p 'require(process.argv[1]).version' "$root/packages/cli/package.json")
# A release is built from the commit the tag v<version> names, and says only <version>. Any other
# build (a candidate, a tree with edits, a copy with no git to ask) says <version>+<commit>, so
# that `ukt --version` never takes it for the release, and its files are named so as well.
label=$version
if ! git -C "$root" diff --quiet HEAD -- 2>/dev/null || [ "$(git -C "$root" rev-parse HEAD 2>/dev/null)" != "$(git -C "$root" rev-parse "v$version^{commit}" 2>/dev/null || echo none)" ]; then
  label="$version+$(git -C "$root" rev-parse --short=7 HEAD 2>/dev/null || echo local)"
fi
name="uketsugi-$label-linux-x64"
stage="$out/$name"

rm -rf "$stage" "$out/$name.tar.gz" "$out/$name.tar.gz.sha256" "$out/install.sh"
mkdir -p "$stage/bin" "$stage/node/bin"

echo "build.sh: building every package"
# A release is a production build whatever environment calls this script: under a test runner's
# NODE_ENV the dashboard would be bundled for development.
NODE_ENV=production pnpm -C "$root" build

echo "build.sh: collecting the command line and its production dependencies"
pnpm -C "$root" --filter @uketsugi/cli deploy --prod "$stage/app" >/dev/null

# The plugins harnesses install are the server package's own files. A person points a harness at
# them, so they sit at the top of the release, where the path is short and stays the same from
# one release to the next, and the server finds them through a link. They are moved before
# anything is stripped: what a plugin's folders are called is the plugin's own business.
server_package=$(cd "$stage/app/node_modules/@uketsugi/server" && pwd -P)
mv "$server_package/plugins" "$stage/plugins"
ln -s "$(realpath --relative-to="$server_package" "$stage/plugins")" "$server_package/plugins"
# Claude Code shows a plugin's version in `claude plugin list`, and "unknown" where the manifest has none.
node "$root/scripts/stamp-plugin.ts" "$stage/plugins" "$label"

# What a running server never reads: sources and tests of our own packages, and the source maps
# and type declarations of everyone's.
find "$stage/app" -type d \( -name src -o -name test -o -name scripts \) -path '*@uketsugi*' -prune -exec rm -rf {} +
rm -rf "$stage/app/src" "$stage/app/test"
find "$stage/app" -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \
  -o -name 'tsconfig*.json' -o -name '*.tsbuildinfo' \) -delete

# The server serves the dashboard from the `web` package's dist beside its own package.
mkdir -p "$server_package/../web"
cp -R "$root/packages/web/dist" "$server_package/../web/dist"

cp "$node_bin" "$stage/node/bin/node"
node_license="$(dirname "$node_bin")/../LICENSE"
if [ -f "$node_license" ]; then cp "$node_license" "$stage/node/LICENSE"; fi
# The licence travels with every copy, and the notice with it: the build stops where either is missing.
cp "$root/LICENSE" "$root/NOTICE" "$stage/"
install -m 755 "$root/deploy/ukt" "$stage/bin/ukt"
printf 'uketsugi %s\nnode %s\nplatform linux-x64\n' "$label" "$node_version" >"$stage/VERSION"
# Where `ukt upgrade` fetches this release's install script: where the build was told it is served.
if [ -n "${UKT_RELEASE_URL:-}" ]; then printf '%s\n' "${UKT_RELEASE_URL%/}" >"$stage/INSTALL_URL"; fi

# The launcher must start on the shipped runtime before anything is packed.
"$stage/bin/ukt" --version >/dev/null

echo "build.sh: packing"
tar -C "$out" --sort=name --owner=0 --group=0 --numeric-owner --hard-dereference \
  -cf - "$name" | gzip -9 >"$out/$name.tar.gz"
(cd "$out" && sha256sum "$name.tar.gz" >"$name.tar.gz.sha256")
sum=$(cut -d' ' -f1 "$out/$name.tar.gz.sha256")
megabytes=$(( ($(stat -c %s "$out/$name.tar.gz") + 500000) / 1000000 ))
url=${UKT_RELEASE_URL:-}
url=${url%/}
sed -e "s|^BUILT_TARBALL=.*|BUILT_TARBALL=\"$name.tar.gz\"|" \
  -e "s|^BUILT_SHA256=.*|BUILT_SHA256=\"$sum\"|" \
  -e "s|^BUILT_SIZE=.*|BUILT_SIZE=\"$megabytes MB\"|" \
  -e "s|^BUILT_URL=.*|BUILT_URL=\"$url\"|" \
  "$root/deploy/install.sh" >"$out/install.sh"
chmod 755 "$out/install.sh"

echo "build.sh: $out/$name.tar.gz ($(du -h "$out/$name.tar.gz" | cut -f1), sha256 $sum)"
# The last thing said, so that it is not missed: whether this install.sh can be published.
if [ -n "$url" ]; then
  echo "build.sh: for publishing. Serve the three files under $url and the install line is:"
  echo "build.sh:   curl -fsSL $url/install.sh | sh"
else
  {
    echo "build.sh: NOT FOR PUBLISHING. UKT_RELEASE_URL was not set, so this install.sh does not know"
    echo "build.sh: where its release is served: \`curl …/install.sh | sh\` fails with it. It installs only"
    echo "build.sh: from the tarball beside it (sh install.sh), which is what the container image and a"
    echo "build.sh: local try need. For a release people install by a piped line, build it again with"
    echo "build.sh:   UKT_RELEASE_URL=<the URL the files are served under> deploy/build.sh"
  } >&2
fi
