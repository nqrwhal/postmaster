#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")"
swift build -c release "$@"
APP="${POSTMASTER_APP_OUTPUT:-$HOME/Applications/Postmaster.app}"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp .build/release/PostmasterMenuBar "$APP/Contents/MacOS/PostmasterMenuBar"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.mayufei.postmaster.menubar</string>
<key>CFBundleName</key><string>Postmaster</string>
<key>CFBundleDisplayName</key><string>Postmaster</string>
<key>CFBundleExecutable</key><string>PostmasterMenuBar</string>
<key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>1.0</string><key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>13.0</string><key>LSUIElement</key><true/>
</dict></plist>
PLIST
xattr -cr "$APP" 2>/dev/null || true
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"
echo "Built $APP"
