# Mobile App Learnings

## React Navigation: "Cannot read property 'stale' of undefined"

**Problem:** Every time a user saved changes in a settings sub-screen (e.g., `/settings/caregiver`), the app crashed with `TypeError: Cannot read property 'stale' of undefined` in `TabRouter.js`.

**Root cause:** The root `_layout.tsx` used `<Slot>` instead of `<Stack>`. With `<Slot>`, only one route renders at a time. Navigating from `(tabs)/settings` to `/settings/caregiver` **unmounted** the entire `(tabs)` layout. When `router.back()` fired, `<Tabs>` tried to remount but `TabRouter` received `undefined` navigation state.

**Fix:** Changed root `_layout.tsx` from `<Slot>` to `<Stack screenOptions={{ headerShown: false }} />`. With `<Stack>`, navigating to `/settings/caregiver` pushes it on top — the tabs stay mounted underneath, preserving navigation state.

**Rules to follow:**
1. **Never use `<Slot>` as root layout** when the app has navigators (`<Tabs>`, `<Stack>`, `<Drawer>`) in child routes that need to stay mounted during cross-group navigation.
2. **Never conditionally render a navigator** — no `if (loading) return <View>` before a `<Tabs>` or `<Stack>` return. Navigators must always be mounted. Use an overlay or hide content instead.
3. **Avoid `router.back()` immediately after state mutations** (e.g., Clerk `user.update()`). The state change can trigger AuthGuard re-renders that race with the navigation. Prefer `Alert.alert("Saved", "...", [{ text: "OK", onPress: () => router.back() }])` to defer navigation.

**Affected files:**
- `app/_layout.tsx` — `<Slot>` → `<Stack>` (root fix)
- `app/(tabs)/_layout.tsx` — removed conditional early return before `<Tabs>`
- `app/settings/caregiver.tsx` — deferred `router.back()` to Alert callback
- `app/settings/loved-one.tsx` — same
- `app/settings/notifications.tsx` — same

## Zod `.transform()` Silently Changes Types for DB-Bound Fields

**Problem:** `POST /api/reminders` returned 500 with no useful error in logs. The mobile app showed a static "Something went wrong" message. Backend logs showed nothing because catch blocks didn't `console.error`.

**Root cause:** In `validators/schemas.js`, `isoDateSchema` had `.transform(date => new Date(date))`. Zod validation middleware (`validateBody`) replaces `req.body` with the validated+transformed result. This silently converted `scheduledTime` from an ISO string (`"2026-04-10T14:00:00.000Z"`) to a JavaScript `Date` object. Drizzle ORM's `timestamp('scheduled_time')` column expects ISO strings — receiving a `Date` object caused a downstream type mismatch.

**Why it was hard to find:**
1. Backend catch blocks sent `res.status(500).json({ error: error.message })` without `console.error` — Railway logs showed nothing.
2. Mobile app displayed a static "Something went wrong" string, hiding the actual API error message and status code.
3. The Zod transform was "correct" in isolation — it's just that the downstream consumer (Drizzle) didn't expect the transformed type.

**Fix (three layers):**
1. **Removed `.transform()` from `isoDateSchema`** — Zod now validates format only. PostgreSQL/Drizzle handle ISO strings natively; no need to convert to Date objects in the validation layer.
2. **Added `routeError()` helper** in `routes/helpers.js` — shared function that `console.error`s with route context before sending 500. Applied across all 10 route files (~24 catch blocks).
3. **Added `getErrorMessage()` utility** in `apps/mobile/src/lib/api.ts` — extracts human-readable error message + status code from `ApiError`, replacing static strings in 4 screens.

**Rules to follow:**
1. **Keep Zod schemas pure for DB-bound fields** — validate format, don't transform types. Let the ORM/database handle type coercion.
2. **Always `console.error` in Express catch blocks** — use `routeError(res, error, 'METHOD /path')` for consistent logging with route context.
3. **Never show static error messages in the UI** — use `getErrorMessage(error, "fallback")` to surface the actual API error and status code for debugging.
4. **Test the full request path** — a Zod schema that looks correct in isolation can break downstream when `validateBody` replaces `req.body` with the transformed result.

**Affected files:**
- `validators/schemas.js` — removed `.transform()` from `isoDateSchema`
- `routes/helpers.js` — added `routeError()` export
- `routes/*.js` (10 files) — replaced bare catch blocks with `routeError()`
- `apps/mobile/src/lib/api.ts` — added `ApiError.displayMessage` getter and `getErrorMessage()` utility
- `apps/mobile/app/(tabs)/reminders.tsx`, `schedule.tsx`, `index.tsx` — dynamic error messages

## Missing Imports Crash at Render Time (Not Build Time)

**Problem:** Onboarding step 5 (`app/(onboarding)/step5.tsx`) used `Check` and `ChevronDown` from `lucide-react-native` on lines 241, 273, and 335, but the import statement only included `ArrowLeft, Plus, X, Lightbulb`. This would crash the screen at render time with `ReferenceError: Check is not defined`.

**Why it wasn't caught:** Metro bundler (React Native) doesn't fail at build time for missing named exports from a package that exists — only at runtime when the undefined symbol is referenced. If no test or manual walkthrough exercises that specific screen, the crash goes unnoticed.

**Fix:** Added `Check` and `ChevronDown` to the import statement.

**Rule:** After adding JSX that references new icons or components, always verify the import statement includes them. Search for all symbol references in the file and cross-check against imports.

## Expo Native Module Missing From Project Dependencies

**Date:** 2026-04-10

**Problem:** The iPhone simulator opened the app, but Metro failed to bundle with `Unable to resolve "expo-updates" from "app/(tabs)/settings.tsx"`. The native rebuild also exposed that an older installed dev client could have a bundle identifier that did not match `app.json`.

**Root cause:**
1. `app/(tabs)/settings.tsx` imported and called `Updates.reloadAsync()`, but `expo-updates` was never added to `apps/mobile/package.json`.
2. `npx expo install expo-updates` was blocked by existing npm peer dependency conflicts in the project, so the missing package was never added automatically.
3. `app.json` and the asset verifier expect `./assets/images/adaptive-icon.png`, but the repo had the same asset tracked as `assets/images/adaptive_icon.png`.
4. Because `ios/` already exists, Expo does not sync `app.json` bundle settings into the native project. The actual iOS bundle identifier lives in `ios/Donna.xcodeproj/project.pbxproj`; it must stay aligned with `com.donna.caregiver`.

**Fix:**
1. Installed the Expo SDK 54 pinned package directly with `npm install expo-updates@~29.0.16 --legacy-peer-deps`.
2. Ran `npx pod-install` so `EXUpdates` and related iOS pods were linked into the native project.
3. Renamed the tracked asset to the canonical `assets/images/adaptive-icon.png` filename used by `app.json` and the asset verifier.
4. Rebuilt with `npx expo run:ios -d "iPhone 17 Pro" --no-install --no-bundler`, which succeeded and removed the Metro bundle error.

**Rules to follow:**
1. If code imports an Expo native module, that package must exist in `apps/mobile/package.json`; importing it in JS is not enough.
2. When `npx expo install` is blocked by peer conflicts, read `expo/bundledNativeModules.json` to get the SDK-pinned version, then install that exact version explicitly.
3. In prebuilt Expo projects with `ios/` or `android/` checked in, treat the native project as the source of truth for bundle identifiers and other synced config.
4. Keep asset filenames in `app.json` exact; Expo config validation will fail on even small naming mismatches.

**Remaining warning:**
1. `expo-doctor` warns that native config fields in `app.json` are not auto-synced because this is not a pure CNG project. Keep `ios/Donna/Info.plist`, `ios/Donna/Donna.entitlements`, and the Xcode project in sync manually.

## Splash Screen Must Be Native And Kept Until Bootstrap Is Ready

**Date:** 2026-05-04

**Problem:** The app could show a blank launch gap even though a splash draft existed in the repo. The checked-in iOS launch storyboard referenced splash constraints but had no splash image view, and `_layout.tsx` hid the native splash as soon as fonts loaded, before Clerk and profile routing finished.

**Fix:**
1. Inserted the draft from `docs/plans/archive/screenshots/splash-screen-draft.jpg` as `assets/images/splash.png`.
2. Pointed Expo splash config at `splash.png` with `resizeMode: "cover"` and sage background `#4A5D4F`.
3. Added the checked-in iOS `SplashScreenLegacy.imageset` and full-screen `SplashScreen.storyboard` image view so EAS/TestFlight builds show the splash without relying on prebuild.
4. Moved `SplashScreen.hideAsync()` behind the initial fonts, Clerk auth, incomplete-account cleanup, and profile-route readiness gate.

**Rule:** In this prebuilt Expo app, changing `app.json` splash fields is not enough. Keep `app.json`, `assets/images/splash.png`, `ios/Donna/SplashScreen.storyboard`, and `ios/Donna/Images.xcassets/SplashScreenLegacy.imageset` in sync.

## No-Profile Clerk Sessions Must Not Enter Onboarding

**Date:** 2026-05-04

**Problem:** Test users and abandoned sign-ups could leave a Clerk session in the keychain without a linked Donna profile. On restart or sign-in, the app used to route that session back into onboarding, which trapped users who needed to start over or use a different sign-in.

**Root cause:** The auth guard only knew "signed in" plus "no seniors", not whether that no-profile session came from the current Create Account flow. After an app restart, that missing context made an abandoned account look like a legitimate onboarding session.

**Fix:**
1. Added `src/lib/pendingOnboardingSession.ts`, an in-memory marker set only by the Create Account and native OAuth account-creation paths before Donna profile creation.
2. `AuthGuard` now treats signed-in/no-profile sessions without that marker as incomplete accounts. It calls `DELETE /api/caregivers/me/incomplete-account`, clears the encrypted onboarding draft, removes profile queries, signs out locally, and returns to landing.
3. Step 1 Back and Success "Use a different sign-in" use the same cleanup path and do not block the user if the Clerk account was already deleted server-side.
4. Sign-in no longer treats a no-profile Clerk user as an onboarding entry point. Fresh onboarding must start from Create Account.

**Rules to follow:**
1. Do not use sign-in with a no-profile user to test fresh onboarding.
2. Maestro fresh onboarding should call `.maestro/manual/auth_create_account.yaml` with a unique `+clerk_test` email.
3. Keep incomplete-account cleanup idempotent from the app's point of view. Server-side deletion can fail or already be done; the app should still clear local state and return to landing.
4. Never persist the pending-onboarding marker. Its runtime-only nature is what distinguishes the current Create Account flow from an abandoned keychain session after restart.

**Coverage:**
- `src/lib/pendingOnboardingSession.test.ts`
- `.maestro/flows/10_onboarding_full.yaml`
- `.maestro/flows/12_incomplete_account_cleanup.yaml`
- `.maestro/flows/13_leave_setup_cleanup.yaml`

## Apple Account Prompt Can Break Maestro Unless Dismissed Explicitly

**Date:** 2026-05-04

**Problem:** iOS simulators can show an "Apple Account" or "Apple Account Verification" sheet during auth/onboarding tests. If Maestro ignores it, subsequent taps target the wrong UI and the flow fails for the wrong reason.

**Fix:** `.maestro/subflows/dismiss_ios_account_prompt.yaml` now handles both prompt titles, taps "Not Now" when present, and falls back to returning to Donna or tapping the top-left escape area.

**Rule:** Include the prompt-dismissal subflow immediately after app launch in mobile auth/onboarding flows that can run on a fresh simulator.

## `expo run:ios` Routes Through Physical-Device Path When `devicectl` Is Broken

**Date:** 2026-05-24

**Problem:** On a Mac with a connected iPhone and a broken `devicectl` (Xcode/CoreDevice mismatch), `npx expo run:ios` warns `Unexpected devicectl JSON version output from devicectl` and then fails with `CommandError: No code signing certificates are available to use.` — even with `--device <simulator-uuid>`. The CLI commits to the physical-device build path before it resolves the simulator UUID, so the flag does not redirect it.

**Workaround:** Drive Xcode directly with `xcodebuild -sdk iphonesimulator -destination "platform=iOS Simulator,id=<UUID>"`, then `xcrun simctl install booted` and `npx expo start --dev-client`. Full recipe lives in `apps/mobile/README.md` under "Running on iOS Simulator → Fallback: xcodebuild directly".

**Rule:** If `expo run:ios` complains about code signing on a sim build, do not chase it with more `--device` flags. Skip the wrapper and use `xcodebuild` directly until the host's `devicectl` is repaired.

## Native Sign in with Apple Needs a Real Provisioning Profile — Even on Simulator

**Date:** 2026-05-24

**Problem:** Building the simulator app without a real signing identity breaks native Sign in with Apple. Two failure modes, depending on how you "skip" signing:

1. `CODE_SIGNING_ALLOWED=NO` → app launches, but `codesign -d --entitlements -` is empty, Apple Sign In errors at runtime, and Metro logs show `[expo-notifications] ... Keychain access failed: A required entitlement isn't present`.
2. Ad-hoc (`CODE_SIGN_IDENTITY="-"`) plus `codesign -f --deep --entitlements Donna.entitlements` to force the entitlement in → `simctl launch` is refused by SpringBoard with `denied by service delegate (SBMainWorkspace)`. No process actually starts.

**Root cause:** `com.apple.developer.applesignin` is a *restricted* entitlement. On iOS 17+, including iOS 26 simulators, SpringBoard requires the entitlement to be backed by a valid provisioning profile. Ad-hoc signing cannot claim restricted entitlements — embedding the key into the binary makes the launch worse, not better. `CODE_SIGNING_ALLOWED=NO` strips the key entirely, so the app starts but the native Apple flow fails the entitlement check at runtime.

**EAS simulator builds do not solve this.** Confirmed 2026-05-24 against build `ef45a5d9-0bb1-4b23-9575-9c89bf451109`: `eas build --profile development --platform ios` (with `ios.simulator: true`) produces an ad-hoc-signed `.app` with an *empty* entitlements dict, identical in this respect to the `xcodebuild` output. EAS strips restricted entitlements from sim builds because the simulator runtime would refuse to launch the app otherwise.

**What actually works to test Apple Sign In:**

- **Run on a physical device with a Personal Team.** Open `ios/Donna.xcworkspace`, target Donna → Signing & Capabilities, set Team to your Apple ID, plug in an iPhone, build & run from Xcode. Xcode generates a real development provisioning profile and Apple Sign In is wired through Apple ID + iCloud on the device.
- **Use the EAS preview/production build on a physical device.** TestFlight or internal distribution. Real Apple Developer provisioning profile.

**Workarounds while developing in the simulator:**

- Use email/password or Google sign-in flows for sim testing.
- Validate post-auth app states through visible email/password or Google flows. Do not add app-code auth bypasses, dev-only Clerk sessions, or Apple Sign-In stubs.

**Rule:** Do not try to fix native Sign in with Apple inside an iOS simulator dev build — it cannot be made to work without a real Apple Developer provisioning profile, and Apple does not issue those for simulator-only distribution. Test Apple Sign In on a physical device.
