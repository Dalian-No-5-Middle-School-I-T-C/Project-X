# Shared by the MinGW and Linux builders.
lock_native_stage() {
  NATIVE_STAGE_LOCK="$1/.build-lock"
  if ! mkdir "$NATIVE_STAGE_LOCK"; then
    echo "Native stage locked at $NATIVE_STAGE_LOCK. If the previous build has stopped, remove the lock directory and retry." >&2
    return 1
  fi
  trap 'rmdir "$NATIVE_STAGE_LOCK"' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

write_native_source_manifest() (
  local root="$1" toolchain="$2" builder="$3" dir files file
  shift 3
  cd "$root"
  cmake -E sha256sum native/CMakeLists.txt "$toolchain" "$builder" scripts/lib/native-build-record.sh
  for dir in "$@"; do
    files="$(find "$dir" -type f \( -name '*.cpp' -o -name '*.h' -o -name '*.hpp' \) | LC_ALL=C sort)"
    if [ -z "$files" ]; then
      echo "No native build inputs in $dir" >&2
      return 1
    fi
    while IFS= read -r file; do
      cmake -E sha256sum "$file"
    done <<< "$files"
  done
)
