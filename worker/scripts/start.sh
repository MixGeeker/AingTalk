#!/bin/bash
cd "$(dirname "$0")/.."
export NODE_ENV=production
node src/index.js "$@"
