# Donna iOS App — Assets Checklist

## Overview

The Donna mobile app requires brand-appropriate icon and splash screen assets for distribution via TestFlight and the App Store. Current asset requirements are defined in `app.json` and reference the `assets/images/` directory.

---

## Required Assets Before Distribution

### App Icon (1024×1024 PNG)
- **File**: `assets/images/icon.png`
- **Size**: 1024×1024 pixels
- **Format**: PNG without transparency
- **Purpose**: App icon displayed on iOS home screen and in App Store
- **Status**: ✅ Present — verified at 1024×1024
- **Design notes**: Should incorporate Donna's sage green (#4A5D4F) and cream (#FDFCF8) colors with a clear, recognizable mark at any size

### Splash Screen (200×200+ PNG)
- **File**: `assets/images/splash.png`
- **Size**: Minimum 200×200 pixels; current draft is 483×1044
- **Format**: PNG without transparency
- **Background**: Donna sage (#4A5D4F) as defined in `app.json`
- **Purpose**: Full-screen launch screen shown while the native app, Clerk, fonts, and initial profile route load
- **Status**: ✅ Present — inserted from `docs/plans/screenshots/splash-screen-draft.jpg`
- **Design notes**: Uses `resizeMode: "cover"` and native iOS `SplashScreenLegacy.imageset` so App Store/TestFlight builds show the Donna splash instead of a blank launch screen.

### Adaptive Icon (1024×1024 PNG)
- **File**: `assets/images/adaptive-icon.png`
- **Size**: 1024×1024 pixels
- **Format**: PNG; current source is opaque RGB
- **Purpose**: Android adaptive icon foreground layer
- **Background**: Cream (#FDFCF8) (defined in `app.json` as `android.adaptiveIcon.backgroundColor`)
- **Status**: ✅ Present — verified at 1024×1024
- **Android requirements**:
  - Safe zone: Center 480×480 pixel square (outside may be masked)
  - Design should work with both rounded and rounded-square masks
  - Consider shadow/depth for layering effect

### Web Favicon (32×32 PNG)
- **File**: `assets/images/favicon.png`
- **Size**: 32×32 pixels
- **Format**: PNG
- **Purpose**: Browser tab icon for web build (from `npm run web`)
- **Status**: ✅ Present — verified at 32×32
- **Design notes**: Must be clear and recognizable at small size

---

## Donna Brand Colors

- **Primary**: #4A5D4F (sage green) — use for text, logos, accents
- **Background**: #FDFCF8 (cream) — app UI and adaptive icon background
- **Splash background**: #4A5D4F (sage green)
- **Accent**: #1A1A1A (charcoal) — text, borders
- **Secondary**: Consider warm accent colors for elderly-friendly interface

---

## Asset Location Structure

```
apps/mobile/assets/
├── images/
│   ├── icon.png              (1024×1024)
│   ├── splash.png            (483×1044)
│   ├── splash-icon.png       (legacy draft copy, not referenced by app.json)
│   ├── adaptive-icon.png     (1024×1024)
│   └── favicon.png           (32×32)
└── README.md
```

---

## Current Configuration

### app.json References

```json
{
  "expo": {
    "icon": "./assets/images/icon.png",
    "splash": {
      "image": "./assets/images/splash.png",
      "resizeMode": "cover",
      "backgroundColor": "#4A5D4F"
    },
    "ios": {
      "bundleIdentifier": "com.donna.caregiver"
    },
    "android": {
      "adaptiveIcon": {
        "foregroundImage": "./assets/images/adaptive-icon.png",
        "backgroundColor": "#FDFCF8"
      },
      "package": "com.donna.caregiver"
    },
    "web": {
      "favicon": "./assets/images/favicon.png"
    }
  }
}
```

---

## Generation Workflow

### Option 1: Design in Figma (Recommended)
1. Create a Figma file or use existing design system
2. Export at specified dimensions with transparency
3. Place in `assets/images/`
4. Run: `npm run verify:assets` to verify required files, PNG headers, and minimum dimensions

### Option 2: Use Expo's Presets (Quick Dev)
For development/testing, Expo can auto-generate icons if you provide a single source image:
```bash
npx expo-app-icon ./source-image.png
```
(Note: Not recommended for production — design control is limited)

### Option 3: Third-Party Icon Generators
- **Figma plugins**: Icon Mixer, Pico
- **Web tools**: Logo.com, Brandmark (for custom design)
- **Design tools**: Adobe Express, Canva Pro

---

## Testing Assets

### Local Testing (Expo Go)
Assets are **not required** for local development with Expo Go:
```bash
npm run android    # Or: npm run ios
```

### Native Build Testing
To test with native icons (recommended before submission):

**iOS (via Xcode):**
```bash
npx eas build --platform ios --local
```

**Android:**
```bash
npx eas build --platform android --local
```

### Expo Preview (Web)
```bash
npm run web
```
Favicon will appear in browser tab.

---

## Before App Store Submission

- [x] App icon (1024×1024) created and placed at `assets/images/icon.png`
- [x] Splash screen present and placed at `assets/images/splash.png`
- [x] Adaptive icon (1024×1024) created and placed at `assets/images/adaptive-icon.png`
- [x] Favicon (32×32) created and placed at `assets/images/favicon.png`
- [x] Required PNGs verified with `npm run verify:assets`
- [x] Native iOS launch storyboard includes the full-screen splash image view and `SplashScreenLegacy.imageset`
- [x] App icon visually inspected as recognizable and nonblank for App Store review
- [x] Checked-in native iOS app icon visually matches `assets/images/icon.png`
- [x] Icons tested in native build: `npx expo run:ios -d "iPhone 17 Pro" --no-install --no-bundler`
- [ ] Adaptive icon safe zone validated (center 480×480 clear)
- [ ] Brand colors consistent across all assets
- [x] No app-icon transparency issues
- [ ] iOS build succeeds with assets included
- [ ] Android build succeeds with adaptive icon
- [ ] App Store submission attempted (will request icons if missing)

---

## Helpful Links

- **Expo Asset Configuration**: https://docs.expo.dev/guides/app-icons/
- **iOS App Icon Requirements**: https://developer.apple.com/design/human-interface-guidelines/app-icons
- **Android Adaptive Icons**: https://developer.android.com/guide/practices/ui_guidelines/icon_design_adaptive
- **Donna Brand**: Check design system or Figma for latest brand guidelines

---

## Notes

- All PNG files should use standard PNG compression (no excessive optimization that breaks mobile readers)
- Transparency should be properly embedded (not white background mistaken for transparency)
- Test on actual devices when possible — simulator rendering can vary
- If icons appear blurry, check DPI/scale in export settings (should be 72 DPI for standard web/mobile)
