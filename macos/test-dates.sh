#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")"
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT
swiftc "$@" Sources/PostmasterMenuBar/DateFormatting.swift Tests/DateFormattingTests.swift -o "$test_dir/date-tests"
"$test_dir/date-tests"
