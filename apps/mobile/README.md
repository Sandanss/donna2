# Donna Mobile App

Expo/React Native caregiver app for iOS and Android. The app uses Clerk for auth and the repo-root Node API for all Donna data. It never calls Pipecat directly.

## Runtime Config

Local Expo and EAS builds require these public variables:

- `EXPO_PUBLIC_API_URL`
- `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`

Set local values in `apps/mobile/.env`. Print only variable names or presence checks, never full values.

```bash
cd apps/mobile
test -f .env
node -e 'const fs=require("fs"); const text=fs.readFileSync(".env","utf8"); for (const key of ["EXPO_PUBLIC_API_URL","EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY"]) { const present=new RegExp("^"+key+"=.+","m").test(text); console.log(key+": "+(present?"present":"missing")); process.exitCode ||= present ? 0 : 1; }'
```

For EAS, each build profile maps to an EAS environment in `eas.json`: `development`, `preview`, and `production`. Verify all three before building:

```bash
cd apps/mobile
for env in development preview production; do
  echo "== $env =="
  npx eas env:exec "$env" 'node -e "const c=require(\"./app.config.js\")(); const e=c.extra||{}; const ok=Boolean(e.apiUrl)&&Boolean(e.clerkPublishableKey)&&e.apiUrl.startsWith(\"https://\")&&/^pk_(test|live)_/.test(e.clerkPublishableKey); console.log({apiUrlPresent:Boolean(e.apiUrl),clerkKeyPresent:Boolean(e.clerkPublishableKey),ok}); process.exit(ok?0:1)"'
done
```

Expected output for every environment is `apiUrlPresent: true`, `clerkKeyPresent: true`, and `ok: true`. If a check fails, update that EAS environment and rebuild; OTA JavaScript cannot fix a binary built without required Expo public config.

## Running on iOS Simulator

Happy path:

```bash
cd apps/mobile
npm run ios            # expo start --ios, picks the booted sim
```

`expo run:ios` requires the dev client (`expo-dev-client`, already a dep) and a working simulator. Boot one first with `open -a Simulator` if none is running.

### Fallback: xcodebuild directly

`npx expo run:ios` can pick the wrong target on a Mac with both a connected iPhone and a stale `devicectl`. Symptoms: `Unexpected devicectl JSON version output` warning followed by `CommandError: No code signing certificates are available to use.` even when you pass `--device <simulator-uuid>`. The CLI commits to the physical-device build path before resolving the simulator UUID, so the flag does not redirect it.

When that happens, skip the Expo wrapper and drive Xcode directly:

```bash
cd apps/mobile

# 1. List simulators, pick the UUID of the one you want.
xcrun simctl list devices booted

# 2. Build for that simulator without signing — fastest path that launches.
SIM_UDID=9FE1AE58-EB90-4D0E-94C3-70AAD6212FDE   # replace with yours
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
npx expo start --dev-client
```

Then launch the app from the simulator home screen — Metro attaches automatically.

**Apple Sign In does not work in this build, by design.** See [`LEARNINGS.md`](LEARNINGS.md) → "Native Sign in with Apple Needs a Real Provisioning Profile". For sim dev work, exercise email/password and Google flows; test Apple Sign In on a physical device or TestFlight build.

## Auth And Onboarding

Fresh setup starts from the visible Create Account screen. The create-account path marks a runtime pending-onboarding session before Donna profile creation.

A Clerk user with no Donna profile is not a valid sign-in destination. If a no-profile Clerk session appears after restart or sign-in, `AuthGuard` calls `DELETE /api/caregivers/me/incomplete-account`, clears the encrypted onboarding draft, signs out locally, and returns to landing.

Native iOS Sign in with Apple uses `startAppleAuthenticationWithoutProfileScopes()` with `expo-apple-authentication`, then passes the Apple identity token to Clerk as `oauth_token_apple`. Apple auth requires:

- `ios.usesAppleSignIn` in `app.json`
- `expo-apple-authentication` in `app.json` plugins and `package.json`
- `com.apple.developer.applesignin` in the native iOS entitlement
- Clerk and Apple Developer provider setup for bundle ID `com.donna.caregiver`

A stale dev-client binary can load fresh JavaScript but still lack native entitlements. Rebuild before debugging Apple auth failures.

## Splash Screen

The splash source is checked in at `assets/images/splash.png` and synced into the native iOS `SplashScreenLegacy.imageset`. Expo config points at that file with `resizeMode: "cover"` and the checked-in iOS project includes a full-screen launch storyboard image view.

Keep the outer pixels of `splash.png`, `splash-icon.png`, and the native iOS splash images sage (`#4A5D4F`). A light or transparent outer canvas can show up as white side bands on taller iPhones when the image is scaled during launch.

The native splash is hidden only after fonts, Clerk auth state, and the initial Donna profile route are ready. This prevents the blank launch gap tracked as BUG-006.

## Validation

```bash
cd apps/mobile
npx --yes npm@10.9.3 ci --include=dev
npm run test:unit
npm run test:auth-guard
npm run verify:assets
npx tsc --noEmit
```

Run the onboarding Maestro flows before App Review or any pilot build:

```bash
cd apps/mobile
npm run test:e2e:onboarding
maestro test .maestro/flows/12_incomplete_account_cleanup.yaml
maestro test .maestro/flows/13_leave_setup_cleanup.yaml
```

Use `.maestro/subflows/tap_digits.yaml` for iOS numeric keypads. Do not use `inputText` for `phone-pad` or `number-pad` fields.

## Release Docs

- [APP_STORE_RELEASE.md](APP_STORE_RELEASE.md)
- [ASSETS.md](ASSETS.md)
- [LEARNINGS.md](LEARNINGS.md)
