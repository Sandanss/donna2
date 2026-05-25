---
name: donna-ios-simulator-setup
description: Use when running the Donna mobile app on an iOS simulator on macOS — picking a build path, attaching Metro, choosing an EAS profile/environment, and handling the gotchas around connected physical iPhones, restricted entitlements (Apple Sign In), the Mac hardware-keyboard override, and Donna's Railway log split between donna-api and donna-pipecat.
---

# Donna iOS Simulator Setup

Mobile app lives in `apps/mobile/` (Expo + React Native + Clerk + Node API). A native `ios/` folder is checked in, so both Expo CLI and direct `xcodebuild` work.

## Workflow

1. Confirm prereqs:
   - Xcode + Command Line Tools installed.
   - A simulator is booted (`open -a Simulator`, then File → New Simulator if needed). Verify: `xcrun simctl list devices booted`.
   - `apps/mobile/.env` has `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`. These bake into the JS bundle and decide the Railway env target — there is no runtime switch.
2. Try the happy path:
   - `cd apps/mobile && npm run ios`
   - Picks the booted sim, compiles + installs if needed, opens dev launcher.
3. If `expo run:ios` fails with `CommandError: No code signing certificates are available to use.` plus an `Unexpected devicectl JSON version output from devicectl` warning:
   - Root cause: physical iPhone connected via USB + broken `devicectl` makes Expo commit to the physical-device build path. `--device <simulator-uuid>` does not redirect it.
   - Use `xcodebuild` with `CODE_SIGNING_ALLOWED=NO` and `-destination "platform=iOS Simulator,id=$SIM_UDID"`. Install with `xcrun simctl install booted <path>.app`, then `npx expo start --dev-client`.
4. Apple Sign In on the simulator: not testable. `com.apple.developer.applesignin` is a restricted entitlement that iOS 17+ requires to be backed by a real provisioning profile. Ad-hoc signing cannot claim it. EAS simulator dev builds ship empty entitlements for the same reason. Test Apple Sign In on a physical device with a Personal Team in Xcode, or via TestFlight / an EAS preview build.
5. Test with the software keyboard visible: **Cmd+K** with the sim focused. The Mac's hardware keyboard otherwise hides the software keyboard, which masks every keyboard-avoidance bug.
6. Logs:
   - JS / Metro logs print in the terminal that started `expo start`.
   - HTTP API logs are on Railway: `railway logs --service donna-api --environment dev`.
   - Voice pipeline logs (irrelevant for mobile-only work) are on `donna-pipecat`.
   - Railway CLI in the repo root defaults to `donna-api`. Always pass `--service` explicitly.

## Guardrails

- Do not chase the `expo run:ios` code-signing error with more `--device` flags — the CLI is not the right surface. Drop to `xcodebuild`.
- Do not try to "fix" Apple Sign In on the sim by adding entitlements with `codesign --entitlements`. The launch is rejected by SpringBoard. Document the limitation and test on a physical device.
- Do not declare a keyboard-avoidance UI bug "fixed" without toggling the software keyboard on (Cmd+K) and reproducing the input-focused state on the sim.
- Do not assume a Railway env points where you think it does — pull the `.env` host (no value, just the hostname) and confirm: dev → `donna-api-dev.up.railway.app`, etc.
- Do not commit `apps/mobile/.env`. Use the presence-check pattern in `apps/mobile/README.md` to verify keys without exposing values.

## When to invoke

- Setting up the mobile app for the first time on a new Mac.
- Diagnosing why `expo run:ios` fails even though a simulator is booted.
- Triaging a UI bug that only shows up when the keyboard is visible (e.g., sticky footer buttons, keyboard-avoiding layouts).
- Picking which Railway service to tail when investigating a request from the mobile app.
- Deciding whether an auth flow bug should be reproduced on a physical device instead of the simulator.

## Related

- `apps/mobile/README.md` → "Running on iOS Simulator" (the canonical recipe).
- `apps/mobile/LEARNINGS.md` → entries on `expo run:ios` devicectl routing, restricted entitlements, Apple Account prompt handling in Maestro.
- `.codex/skills/donna-ios-release/SKILL.md` → companion skill for App Store / TestFlight builds (physical-device + provisioning).
- `.codex/skills/mobile-auth-e2e/SKILL.md` → companion skill for Clerk auth state machine and Maestro flows.
