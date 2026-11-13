#!/bin/sh
# Packages the extension and installs it into VS Code.
set -e
cd "$(dirname "$0")/.."
[ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
CODE="${CODE:-/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code}"
npm run package --silent
VSIX="patisserie-$(node -p "require('./package.json').version").vsix"
"$CODE" --install-extension "$VSIX" --force
echo "Installed $VSIX. Run 'Developer: Restart Extension Host' in VS Code to load it."
