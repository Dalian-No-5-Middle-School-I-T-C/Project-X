#!/usr/bin/env bash
# Compatibility entry point for existing installations.
exec bash "$(dirname -- "${BASH_SOURCE[0]}")/setup-mariadb.sh" "$@"
