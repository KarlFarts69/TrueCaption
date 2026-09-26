#!/bin/bash
# Mac equivalent of build.bat. Builds the .dmg into dist/.
#
# This builds the MAC app only. A Windows .exe cannot be built from macOS
# without Wine — run build.bat on a Windows machine for that.
cd "$(dirname "$0")" || exit 1
echo "Installing dependencies..."
npm install || exit 1
echo "Building macOS .dmg..."
npm run dist:mac || exit 1
echo
echo "Done. Look in the dist/ folder."
read -r -p "Press Enter to close..."
