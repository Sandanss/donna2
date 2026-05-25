---
name: donna-ios-simulator-setup
description: Use when the user wants to run the Donna mobile app on an iOS simulator on macOS — building, installing, attaching Metro, picking the right environment, and surfacing the common gotchas (devicectl confusion, code signing, Apple Sign In, hardware keyboard hiding the software keyboard, language flag rendering). Read this before invoking expo run:ios on a fresh Mac or after a long break from mobile dev.
---

# Running Donna on an iOS Simulator (Mac)

The mobile app is Expo / React Native + Clerk + Node API. It lives in `apps/mobile/`. The repo also includes a checked-in native `ios/` folder (already prebuilt), so the simulator path supports both Expo CLI and direct `xcodebuild`.

## Prerequisites

- Xcode + Command Line Tools installed (`xcode-select --install` if missing).
- A booted simulator: `open -a Simulator` then pick a device from File → New Simulator. Confirm with `xcrun simctl list devices booted`.
- `apps/mobile/.env` contains `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`. These are baked into the JS bundle at build time and decide which Railway env the app talks to (dev / staging / prod). Use the `node -e ...` snippet in `apps/mobile/README.md` to verify presence without printing values.

## Happy path

```bash
cd apps/mobile
npm run ios   # expo start --ios — picks the booted sim
```

If a prior dev client is already installed on the sim, the app launches and connects to Metro automatically. Otherwise, `expo run:ios` compiles + installs.

## When `expo run:ios` fails with code signing on a sim build

Symptom: `Unexpected devicectl JSON version output from devicectl` warning followed by `CommandError: No code signing certificates are available to use.` — even with `--device <simulator-uuid>`.

Cause: a physical iPhone is connected via USB and the Mac's `devicectl` is broken (Xcode / CoreDevice version mismatch). Expo CLI commits to the physical-device build path before resolving the simulator UUID, so the flag does not redirect it.

Fix: skip Expo CLI and drive Xcode directly. Use `CODE_SIGNING_ALLOWED=NO` — this is the fastest path that launches.

```bash
cd apps/mobile

# 1. Pick the booted sim UUID.
xcrun simctl list devices booted

# 2. Build (Pods are cached after the first run; subsequent builds are ~30s).
SIM_UDID=<paste-from-step-1>
xcodebuild \
  -workspace ios/Donna.xcworkspace \
  -scheme Donna \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination "platform=iOS Simulator,id=$SIM_UDID" \
  -derivedDataPath ios/build \
  CODE_SIGNING_ALLOWED=NO \
  build

# 3. Install onto the booted simulator and start Metro.
xcrun simctl install booted ios/build/Build/Products/Debug-iphonesimulator/Donna.app
xcrun simctl launch booted com.donna.caregiver
npx expo start --dev-client
```

If the app comes up on the Expo dev launcher screen (not the app itself), tap the localhost entry under "Development servers" or enter `http://localhost:8081` manually. You can also `xcrun simctl openurl booted "donna://expo-development-client/?url=http://localhost:8081"`.

## Apple Sign In does not work in any simulator dev build

`com.apple.developer.applesignin` is a restricted entitlement that iOS 17+ (including iOS 26 simulators) requires to be backed by a real Apple Developer provisioning profile. Ad-hoc signing cannot claim it — adding the entitlement to the binary makes the launch fail (`denied by service delegate (SBMainWorkspace)`). Stripping it with `CODE_SIGNING_ALLOWED=NO` makes the app launch but the Apple OAuth handshake fails at runtime (Metro logs show `[expo-notifications] ... Keychain access failed: A required entitlement isn't present`).

EAS development builds (`eas build --profile development --platform ios`) ship empty entitlements for the same reason — they're not a fix.

Workarounds for sim dev:
- Test email/password and Google sign-in flows on the sim.
- Test Apple Sign In on a physical device with a Personal Team set in Xcode (Donna.xcworkspace → Signing & Capabilities), or via TestFlight / EAS preview build.

See `apps/mobile/LEARNINGS.md` → "Native Sign in with Apple Needs a Real Provisioning Profile".

## Hardware keyboard hides the software keyboard

When Simulator.app is focused, the Mac's keyboard is treated as a connected hardware keyboard and iOS hides the software one. This masks every keyboard-avoidance bug because no keyboard is visible on screen.

Toggle the software keyboard with:
- **Cmd+K** with the sim focused
- Or menu **I/O → Keyboard → Toggle Software Keyboard**
- Or uncheck **I/O → Keyboard → Connect Hardware Keyboard** for a permanent disconnect

Always test keyboard-avoidance bugs with the software keyboard visible. The `KeyboardAwareFooter` regression on 2026-05-24 went unnoticed in earlier review because it was tested with the hardware keyboard active.

## Logs gotcha — mobile session

- Metro logs (what the JS thread prints, `console.log`, `[AuthGuard]`, RN errors) appear in the terminal running `expo start --dev-client`.
- API logs (what `donna-api` does with the requests) are on Railway: `railway logs --service donna-api --environment dev`.
- Voice / call logs live on `donna-pipecat`. The mobile app never calls Pipecat directly, so during mobile dev you almost always want `donna-api`.
- Railway CLI in the repo root defaults to `donna-api`. Always pass `--service` explicitly to avoid confusion.

## Environment mapping (build time, not runtime)

`apps/mobile/eas.json` maps profiles to EAS environments:
- `development` → EAS env "development" → dev Railway API + dev Clerk key
- `preview` → EAS env "preview"
- `production` → EAS env "production"

Local `expo start` reads `apps/mobile/.env`, which by convention points at dev. To switch the app to staging or prod you must rebuild — there is no runtime switch.

## Verification checklist (run before reporting "the simulator works")

```bash
cd apps/mobile
npx tsc --noEmit               # types compile
npm run test:auth-guard        # auth guard invariants
npm run verify:assets          # required images present
codesign -d --entitlements - ios/build/Build/Products/Debug-iphonesimulator/Donna.app | head -10
```

Then on the sim:
- App launches to the Create Account screen for a fresh install.
- Toggle the software keyboard (Cmd+K), tap a text input, confirm the sticky Next button stays just above the keyboard.
- Sign in via email/password (Apple is expected to fail — see above).
- Settings → Delete Account exercises the hardDelete cascade against dev; check `railway logs --service donna-api --environment dev` for the `DELETE /api/caregivers/me/account` line.
