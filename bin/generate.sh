#!/usr/bin/env bash
set -e

node_modules/.bin/ts-node src/generate.ts $@
