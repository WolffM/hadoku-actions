#!/bin/sh
# Stand-in npm for next-version's selftest: the registry holds 0.4.6 and 0.4.7,
# and neither was published by this commit.
case "$3" in
  versions) echo '["0.4.6","0.4.7"]' ;;
  gitHead) echo 0000000000000000000000000000000000000000 ;;
  *) echo "fake-npm: unexpected $*" >&2; exit 2 ;;
esac
