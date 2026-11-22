#!/usr/bin/env bash
# Builds audiotee (system audio capture, Core Audio taps, macOS 14.2+) at the pinned commit.
#   tools/audiotee/build.sh        (or: cd app && npm run build:audiotee)
# Result: tools/audiotee/bin/audiotee (gitignored). Source goes to tools/audiotee/src (gitignored).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="https://github.com/makeusabrew/audiotee.git"
sha="$(tr -d '[:space:]' < "$here/VERSION")"
src="$here/src"
bin="$here/bin"

if [[ ! -d "$src/.git" ]]; then
  git init -q "$src"
  git -C "$src" remote add origin "$repo"
fi
if [[ "$(git -C "$src" rev-parse -q --verify HEAD 2>/dev/null || true)" != "$sha" ]]; then
  echo "fetching audiotee $sha"
  git -C "$src" fetch -q --depth 1 origin "$sha"
  git -C "$src" checkout -q --detach FETCH_HEAD
fi
actual="$(git -C "$src" rev-parse HEAD)"
if [[ "$actual" != "$sha" ]]; then
  echo "ERROR: checked out $actual, expected $sha" >&2
  exit 1
fi

mkdir -p "$bin"
echo "building audiotee $sha (release)"
if (cd "$src" && swift build -c release) && out="$(cd "$src" && swift build -c release --show-bin-path)"; then
  cp "$out/audiotee" "$bin/audiotee"
else
  # Some Command Line Tools installs ship a broken swift-package (dyld "Symbol not found").
  # Same result without SwiftPM: the AudioTeeCore module, then the CLI linked against it.
  echo "swift build failed, building with swiftc directly"
  obj="$src/.build/swiftc-release"
  rm -rf "$obj" && mkdir -p "$obj"
  target="$(uname -m)-apple-macosx14.2"
  # Also, the default SDK can be newer than the compiler ("this SDK is not supported by the
  # compiler"): use $SDKROOT, else the newest SDK built by a Swift no newer than ours.
  if [[ -z "${SDKROOT:-}" ]]; then
    have="$(swiftc --version 2>&1 | sed -nE 's/.*Apple Swift version ([0-9]+\.[0-9]+).*/\1/p' | head -1)"
    for sdk in $(ls -d /Library/Developer/CommandLineTools/SDKs/MacOSX[0-9]*.sdk 2>/dev/null | sort -t X -k2 -V -r); do
      iface="$(ls "$sdk"/usr/lib/swift/Swift.swiftmodule/*.swiftinterface 2>/dev/null | head -1)"
      [[ -n "$iface" ]] || continue
      built="$(sed -nE 's/.*swift-compiler-version: Apple Swift version ([0-9]+\.[0-9]+).*/\1/p' "$iface" | head -1)"
      if [[ -n "$built" && "$(printf '%s\n%s\n' "$built" "$have" | sort -V | tail -1)" == "$have" ]]; then
        export SDKROOT="$sdk"
        break
      fi
    done
  fi
  echo "SDK: ${SDKROOT:-default}"
  core=("$src"/Sources/AudioTeeCore/*/*.swift)
  cli=("$src"/Sources/AudioTeeCLI/*.swift)
  (cd "$obj" && swiftc -O -wmo -target "$target" ${SDKROOT:+-sdk "$SDKROOT"} -parse-as-library -module-name AudioTeeCore \
    -emit-module -emit-module-path "$obj/AudioTeeCore.swiftmodule" -c "${core[@]}" -o "$obj/AudioTeeCore.o")
  swiftc -O -wmo -target "$target" ${SDKROOT:+-sdk "$SDKROOT"} -module-name audiotee -I "$obj" "${cli[@]}" "$obj/AudioTeeCore.o" -o "$bin/audiotee"
fi
echo "built $bin/audiotee"
