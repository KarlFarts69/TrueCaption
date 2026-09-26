#!/bin/bash
# Mac equivalent of start.bat. Double-clickable from Finder.
cd "$(dirname "$0")" || exit 1
echo "Installing dependencies..."
npm install || exit 1
echo "Starting TrueCaption..."
npm start
