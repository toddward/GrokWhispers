'use strict';

// With a Developer ID (CSC_LINK / CSC_NAME), sign normally with the hardened
// runtime for notarization. Without one, ad-hoc sign: Apple Silicon kills
// unsigned apps, and flipping Electron fuses invalidates the linker signature.
const hasIdentity = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);

const config = {
  "publish": null,
  "appId": "app.grokwhispers",
  "productName": "GrokWhispers",
  "files": [
    "src/**",
    "assets/**",
    "package.json"
  ],
  "mac": {
    "category": "public.app-category.productivity",
    "target": [
      "dmg",
      "zip"
    ],
    "icon": "assets/icon.png",
    "entitlements": "build/entitlements.mac.plist",
    "entitlementsInherit": "build/entitlements.mac.plist",
    "extendInfo": {
      "LSUIElement": true,
      "NSMicrophoneUsageDescription": "GrokWhispers records your voice while you hold the dictation hotkey so it can be transcribed by Grok Voice.",
      "NSAppleEventsUsageDescription": "GrokWhispers sends a paste keystroke to the app you are dictating into."
    }
  },
  "linux": {
    "target": [
      "AppImage",
      "deb"
    ],
    "category": "Utility",
    "icon": "assets/icon.png",
    "executableName": "grokwhispers",
    "maintainer": "GrokWhispers contributors <https://github.com/toddward/GrokWhispers>",
    "vendor": "GrokWhispers"
  },
  "npmRebuild": false,
  "electronFuses": {
    "runAsNode": false,
    "enableCookieEncryption": true,
    "enableNodeOptionsEnvironmentVariable": false,
    "enableNodeCliInspectArguments": false,
    "enableEmbeddedAsarIntegrityValidation": true,
    "onlyLoadAppFromAsar": true
  }
};

config.mac.hardenedRuntime = hasIdentity;
if (!hasIdentity) config.mac.identity = '-';

module.exports = config;
