#!/bin/sh
# PID 1 for the slim computer. Serves the workspace on 6080: the readiness
# endpoint the Kubernetes provider probes, and a directory listing for browsing.
set -eu
export HOME="${HOME:-/home/botcamp}"
mkdir -p "$HOME"
cd "$HOME"
exec busybox httpd -f -p 6080 -h "$HOME"
