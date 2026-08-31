#!/bin/bash
set -euo pipefail

# Serve the compiled LideCode server from its deployed location.
# The server reads PORT from the environment (defaults to 5000 in server.ts).

cd /opt/LideCode

exec node dist/server.js
