# Bug Tracker

## Open Bugs — Moved to GitHub Issues

Bug tracking has moved to **GitHub Issues** for easier filing from mobile.

**[View all open bugs](https://github.com/dmdzco/donna2/issues?q=is%3Aissue+is%3Aopen+label%3Abug)**

To file a new bug: open the GitHub mobile app → tap "+" → "New Issue" → select "Bug Report" template.

### Migrated Issues (April 2026)
| Bug | GitHub Issue |
|-----|-------------|
| BUG-003: App auto-skips Get Started page | [#171](https://github.com/dmdzco/donna2/issues/171) |
| BUG-004: Error on "Go to Dashboard" after onboarding | [#172](https://github.com/dmdzco/donna2/issues/172) |
| BUG-005: User data persists after force quit | [#173](https://github.com/dmdzco/donna2/issues/173) |
| BUG-006: No splash screen while app loads — resolved 2026-05-04 | [#174](https://github.com/dmdzco/donna2/issues/174) |
| BUG-007: No "Done" button on keyboard | [#175](https://github.com/dmdzco/donna2/issues/175) |
| BUG-008: Buttons/Power Bar text should be lower | [#176](https://github.com/dmdzco/donna2/issues/176) |
| BUG-009: Add "Myself" option in onboarding | [#177](https://github.com/dmdzco/donna2/issues/177) |
| BUG-010: Sign In button should be centered | [#178](https://github.com/dmdzco/donna2/issues/178) |
| BUG-011: Dark mode call times not visible | [#179](https://github.com/dmdzco/donna2/issues/179) |
| BUG-012: Duplicate phone error appears too late | [#180](https://github.com/dmdzco/donna2/issues/180) |

---

## Resolved Bugs (Archive)

### BUG-006: No splash screen while app loads
- **Reported**: 2026-04-13
- **Resolved**: 2026-05-04
- **GitHub Issue**: [#174](https://github.com/dmdzco/donna2/issues/174)
- **App**: Mobile (launch/auth bootstrap)
- **Severity**: High — creates a blank launch experience during app startup
- **Description**: The mobile app had a draft splash asset in the repo, but the native iOS launch storyboard did not include the splash image view and the React app hid the native splash as soon as fonts loaded, before Clerk/profile bootstrap finished.
- **Expected**: Cold launch should show the Donna splash immediately and keep it visible until the initial auth/profile route is ready.
- **Status**: Fixed — inserted the draft as `assets/images/splash.png`, wired Expo splash config to it, added the native iOS `SplashScreenLegacy.imageset` and full-screen launch storyboard image, and delayed `SplashScreen.hideAsync()` until auth/profile bootstrap is ready.
- **Validation**: `cd apps/mobile && npm run verify:assets`; `cd apps/mobile && npx tsc --noEmit`; native simulator/TestFlight cold-launch smoke test.

### BUG-013: Incomplete mobile onboarding accounts trap users after restart/sign-in
- **Reported**: 2026-05-04
- **Resolved**: 2026-05-04
- **App**: Mobile (auth + onboarding)
- **Severity**: Critical — can trap a user in setup with a Clerk account that has no Donna profile
- **Description**: A user could create a Clerk account, abandon onboarding before Donna profile creation, then reopen or sign in later and be routed back into onboarding with no reliable way to restart from a clean account.
- **Expected**: Fresh onboarding should start from Create Account. A signed-in Clerk user without a Donna profile outside the current Create Account runtime should be treated as incomplete setup, cleaned up, signed out locally, and returned to landing.
- **Fix branch/commit**: `main` commit `c571f92` (`fix mobile incomplete onboarding cleanup`) plus `f83a799` (`test mobile apple account prompt dismissal`)
- **Status**: Fixed — added a runtime pending-onboarding marker, `DELETE /api/caregivers/me/incomplete-account`, cleanup on Step 1 Back and "Use a different sign-in", and Maestro flows for incomplete-account cleanup and leave-setup cleanup.
- **Validation**: `cd apps/mobile && npm run test:unit`; `cd apps/mobile && maestro test .maestro/flows/12_incomplete_account_cleanup.yaml`; `cd apps/mobile && maestro test .maestro/flows/13_leave_setup_cleanup.yaml`

### BUG-001: Signup rejects all passwords as "found in data leak"
- **Reported**: 2026-04-13
- **Resolved**: 2026-04-14
- **Reporter**: Nick
- **App**: Mobile (consumer signup)
- **Severity**: Critical — blocks new user registration
- **Description**: When creating an account, every password entered is rejected with a message saying it was "found in data leak" and that a different password must be used. After 7+ attempts with different passwords, none were accepted. This effectively prevents any new user from signing up.
- **Steps to Reproduce**:
  1. Open the app and begin account creation
  2. Enter email and any password
  3. Password is rejected as "found in data leak"
  4. Try different passwords — all rejected
- **Expected**: Valid, strong passwords should be accepted
- **Screenshot**: ![BUG-001](screenshots/bug-001-password-rejected.png)
- **Fix branch**: `codex/mobile-onboarding-bugs`
- **Status**: Fixed in `codex/mobile-onboarding-bugs` — restores native strong-password support, raises local minimum length, improves breached-password guidance, and updates mobile auth E2E passwords to be unique per run.

---

### BUG-002: "Continue to Homepage" fails after completing signup
- **Reported**: 2026-04-13
- **Resolved**: 2026-04-14
- **Reporter**: Nick
- **App**: Mobile (onboarding success screen)
- **Severity**: Critical — blocks onboarded users from reaching the app
- **Description**: After completing the full signup/onboarding flow and reaching the success screen, tapping "Continue to Homepage" displays the error: "Failed to complete onboarding. Please try again." Retrying does not resolve the issue. There is no back button or alternative navigation, so the user is completely stuck on this screen with no way to proceed or go back.
- **Steps to Reproduce**:
  1. Complete full signup and onboarding flow
  2. Reach the success/congratulations screen
  3. Tap "Continue to Homepage"
  4. Error appears: "Failed to complete onboarding. Please try again"
  5. Tapping again produces the same error
- **Expected**: User should be navigated to the main dashboard. If an error occurs, there should be a way to go back or clear guidance on the issue.
- **Screenshot**: ![BUG-002](screenshots/bug-002-onboarding-error.png)
- **Fix branch**: `codex/mobile-onboarding-bugs`
- **Status**: Fixed in `codex/mobile-onboarding-bugs` — aligns mobile call-schedule payloads with backend validation, prevents empty recurring schedules, and makes backend onboarding writes transactional.

## Facundo QA TODOs

- [ ] **BUG-001 signup password check**: Create a fresh mobile account on an iPhone/simulator and confirm the password field offers or accepts a strong password instead of repeatedly showing Clerk's "found in data leak" rejection.
- [ ] **BUG-002 full onboarding completion**: Complete all five onboarding steps, tap "Continue to Homepage", and confirm the app creates the senior, links the caregiver, creates reminders, and lands on the dashboard.
- [ ] **BUG-013 abandoned setup cleanup**: Create a fresh account, stop before profile creation, force quit/reopen without clearing keychain, and confirm the app returns to landing instead of sending the user back into onboarding.
- [ ] **BUG-013 leave setup cleanup**: Create a fresh account, land on "About You", tap Back, and confirm the app returns to landing without "Couldn't leave setup".
- [ ] **Recurring schedule validation**: On the Schedule Donna step, choose "Recurring" without selecting any day and confirm the app blocks progress with "Choose at least one day for this recurring call."
- [ ] **Duplicate loved-one phone recovery**: Try onboarding with a loved-one phone number already used by another senior and confirm the app shows the duplicate-phone message rather than the generic onboarding failure.
