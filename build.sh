#!/bin/bash
# Install poppler-utils for pdftotext
apt-get update -qq && apt-get install -y -qq poppler-utils
echo "pdftotext version: $(pdftotext -v 2>&1 | head -1)"
# Install node dependencies
npm install --ignore-scripts
