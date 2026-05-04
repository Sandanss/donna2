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

## Auth And Onboarding

Fresh setup starts from the visible Create Account screen. The create-account path marks a runtime pending-onboarding session before Donna profile creation.

A Clerk user with no Donna profile is not a valid sign-in destination. If a no-profile Clerk session appears after restart or sign-in, `AuthGuard` calls `DELETE /api/caregivers/me/incomplete-account`, clears the encrypted onboarding draft, signs out locally, and returns to landing.

Native iOS Sign in with Apple uses Clerk's `useSignInWithApple()` flow. Apple auth requires:

- `ios.usesAppleSignIn` in `app.json`
- `expo-apple-authentication` in `app.json` plugins and `package.json`
- `com.apple.developer.applesignin` in the native iOS entitlement
- Clerk and Apple Developer provider setup for bundle ID `com.donna.caregiver`

A stale dev-client binary can load fresh JavaScript but still lack native entitlements. Rebuild before debugging Apple auth failures.

## Splash Screen

The draft splash is checked in at `assets/images/splash.png` and comes from `docs/plans/screenshots/splash-screen-draft.jpg`. Expo config points at that file with `resizeMode: "cover"` and the checked-in iOS project includes `SplashScreenLegacy.imageset` plus a full-screen launch storyboard image view.

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
