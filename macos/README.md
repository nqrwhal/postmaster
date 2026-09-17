# Postmaster menu bar app

Requires macOS 13+ and Xcode command line tools. Build a local ad-hoc signed app with:

```sh
cd macos
chmod +x build-app.sh
./build-app.sh
open ~/Applications/Postmaster.app
```

Run `./test-dates.sh` for date formatting checks (calendar dates, legacy cached estimates, and daylight-saving transitions). Both scripts accept compiler/build arguments; for example, select an installed SDK with `./build-app.sh --sdk /path/to/MacOSX.sdk` or `./test-dates.sh -sdk /path/to/MacOSX.sdk`.

The app uses the Tailscale identity proxy through the configured server URL and stores no provider credentials. It caches the last successful package response for offline viewing. Open Settings using the footer gear to change the server URL, launch at login, or quit; mutations are only sent while connected. The app polls every 30 seconds while its menu is open.

The popover grows to show up to ten active packages in the selected direction, without a scroll area. Larger lists have a link to the full dashboard. Package details take priority; add, dashboard, refresh, and settings actions live in the footer. Right-click a package to open its carrier tracking page or refresh it individually. The add form also supports OnTrac, DHL, and Other carrier. New packages default to the currently selected direction.
