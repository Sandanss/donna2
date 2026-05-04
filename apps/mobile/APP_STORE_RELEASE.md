# Donna Mobile App Store Release Guide

Last updated: May 4, 2026.

## Current Local Status

- iOS bundle ID is aligned to `com.donna.caregiver` in Expo config and native iOS.
- Native Sign in with Apple is enabled through `ios.usesAppleSignIn`, the `expo-apple-authentication` plugin, and the checked-in iOS entitlement `com.apple.developer.applesignin`.
- Apple auth in the app uses Clerk's native `useSignInWithApple()` flow; Google remains browser OAuth.
- `eas.json` no longer contains fake Apple submit placeholders.
- App icons are present at `1024x1024`; the iOS app icon has no alpha channel.
- The draft splash screen is inserted as `assets/images/splash.png`, wired into Expo config, and present in the checked-in native iOS launch storyboard/assets.
- `npm run verify:assets` checks required image presence, PNG validity, and minimum dimensions. It does not replace visual inspection of the installed icon on device/TestFlight.
- Java is available through Homebrew for Maestro.
- Mobile settings includes an in-app account deletion path.
- Fresh onboarding starts from Create Account. A no-profile Clerk sign-in is treated as incomplete setup and cleaned up through `DELETE /api/caregivers/me/incomplete-account`.
- Official website: `https://calldonna.co`.
- App Store privacy policy URL: `https://calldonna.co/privacy`.
- App Store support URL: `https://calldonna.co/support`.
- Third-party services URL: `https://calldonna.co/third-party`.
- The iOS privacy manifest declares linked, non-tracking data collection for app functionality.
- EAS project is linked as `@dmdzco/donna-caregiver`.
- EAS project ID is `aa482a04-3f14-4373-a654-42e51f1bd7b0`.

## Before You Build for App Store

1. Confirm Expo/EAS login:

   ```bash
   cd apps/mobile
   eas whoami
   eas project:info
   ```

   EAS is already linked for `@dmdzco/donna-caregiver`. If this repo is cloned elsewhere, run `eas login` and `eas project:init` again only if the project link is missing.

2. Switch Clerk to production:

   - Create or choose the Clerk production instance.
   - Set `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` to the production publishable key for mobile builds.
   - Set `EXPO_PUBLIC_API_URL` to the production Node API base URL for mobile builds.
   - Set the backend `CLERK_SECRET_KEY` to the matching production secret key.
   - Confirm allowed redirects/deep links include the `donna` scheme and the final bundle ID.
   - Confirm Sign in with Apple is enabled for the native iOS app in Clerk and Apple Developer for bundle ID `com.donna.caregiver`.

   Verify every EAS environment used for builds without printing values:

   ```bash
   for env in development preview production; do
     echo "== $env =="
     npx eas env:exec "$env" 'node -e "const c=require(\"./app.config.js\")(); const e=c.extra||{}; const ok=Boolean(e.apiUrl)&&Boolean(e.clerkPublishableKey)&&e.apiUrl.startsWith(\"https://\")&&/^pk_(test|live)_/.test(e.clerkPublishableKey); console.log({apiUrlPresent:Boolean(e.apiUrl),clerkKeyPresent:Boolean(e.clerkPublishableKey),ok}); process.exit(ok?0:1)"'
   done
   ```

   Expected result for each environment is `apiUrlPresent: true`, `clerkKeyPresent: true`, and `ok: true`. If a build profile fails this check, update that EAS environment first and rebuild the binary; OTA JavaScript cannot add missing Expo public config to a binary that was built without it.

3. Create the Apple app record:

   - Apple Developer account must be active.
   - Bundle ID: `com.donna.caregiver`.
   - App name: `Donna Companion`.
   - SKU: choose an internal stable value, for example `donna-caregiver-ios`.

4. Complete App Store Connect metadata:

   - Privacy policy URL.
   - Support URL.
   - Description, keywords, category, age rating, pricing/availability.
   - Export compliance encryption answers.
   - Accessibility Nutrition Labels after an accessibility pass.
   - Review notes and demo account. Use dummy data only; do not use real PHI.
   - Screenshots captured from dummy accounts only; no real transcripts, reminders, medical notes, phone numbers, or caregiver data.

5. Complete privacy and compliance review:

   - App Store privacy labels must match the app and all SDK/vendor data practices.
   - Confirm whether the app should declare health data in App Store Connect.
   - Confirm BAA/vendor posture before making HIPAA-adjacent claims.
   - Confirm account deletion behavior with legal/product. The app now deletes Donna data for sole-caregiver seniors and unlinks shared seniors, then attempts Clerk user deletion.

## Build, Test, Submit

1. Run local checks:

   ```bash
   npx --yes npm@10.9.3 ci --include=dev
   npm run verify:assets
   npm run test:unit
   npm run test:auth-guard
   npx tsc --noEmit
   npx expo-doctor
   ```

   `expo-doctor` currently reports the non-CNG/native-folder warning. That warning is expected while `ios/` is checked in; manually keep native iOS config synced when changing `app.json`.

2. Test on simulator and physical iPhone:

   ```bash
   npm run ios
   npm run test:e2e
   maestro test .maestro/flows/12_incomplete_account_cleanup.yaml
   maestro test .maestro/flows/13_leave_setup_cleanup.yaml
   ```

   Push notification registration requires a physical device and a real EAS project ID.
   Apple Sign-In requires a native build with the Apple entitlement; a stale simulator/dev-client binary can load fresh JavaScript but still fail the native Apple sheet.
   `app.json` currently sets `ios.supportsTablet` to `false`, but run at least one iPad compatibility smoke test before App Review if App Store Connect still makes the build available on iPad.

3. Build for production:

   ```bash
   eas build --platform ios --profile production
   ```

4. Submit to App Store Connect:

   ```bash
   eas submit --platform ios --profile production
   ```

   You can let EAS prompt for Apple credentials, or configure App Store Connect API key credentials in EAS.

5. Distribute through TestFlight first, then submit the selected build for App Review in App Store Connect.

## App Review Smoke Checklist

Use a fake demo caregiver account and fake senior data only.

- Install the newest TestFlight build number; do not retest an older preview/internal link.
- On iPhone and iPad, sign in with Apple from the visible auth screen.
- Create a fresh account through Create Account, complete onboarding, tap "Go to Dashboard", and confirm the dashboard loads.
- Start onboarding, tap Back from Step 1, and confirm the app returns to landing without a "couldn't leave setup" error.
- Start onboarding, force quit before profile creation, relaunch without clearing keychain, and confirm the app cleans the incomplete account and returns to landing.
- Confirm the app icon on the device is recognizable and nonblank.
- Confirm the Donna splash screen appears immediately on cold launch and remains visible until the first auth/profile route is ready.
- Confirm the App Store Connect device-family/availability settings match the intended support matrix. If iPad remains available, repeat Apple sign-in and onboarding cleanup smoke tests on an iPad simulator or device.
- Confirm review/demo data contains no real transcripts, reminder text, medical notes, phone numbers, or caregiver data.

## Timing Note

Apple says that beginning April 28, 2026, App Store Connect uploads must use Xcode 26 or later with an iOS 26 SDK. This machine currently has Xcode 26.3 and an iPhoneOS 26.2 SDK, so the local toolchain is in range.
