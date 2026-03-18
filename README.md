# Mouse Tooltip Translator for Safari

Hover over any text to see an instant Hebrew translation. Works on **every website** — including GitHub, Gmail, and sites with strict security policies.

> 🇮🇱 **Built for Hebrew speakers** — translates any language → Hebrew automatically.

<p align="center">
  <img src="screenshots/demo.png" alt="Demo" width="600">
</p>

## Features

- **Hover to translate** — hover over any paragraph to see instant translation
- **Select to translate** — highlight specific text to translate just that selection
- **Works everywhere** — uses a background script to bypass Content Security Policy (CSP) restrictions
- **Smart detection** — skips Hebrew/Arabic text automatically, no unnecessary translations
- **Minimal UI** — clean macOS-native tooltip that fits the text, no wasted space
- **RTL support** — Hebrew text displays right-to-left correctly
- **Keyboard shortcuts:**
  - `Alt + T` — toggle translator on/off
  - `Esc` — dismiss tooltip

## Installation

### Option 1: Download DMG (Easiest)

1. Download **[TooltipTranslator-1.0.0.dmg](https://github.com/achiya-automation/safari-tooltip-translator/releases/latest)** from Releases
2. Open the DMG and drag **Tooltip Translator** to Applications
3. Open **Tooltip Translator.app** from Applications (right-click → Open if you see a security warning)
4. Enable the extension in Safari:
   - Go to **Safari → Settings → Extensions**
   - Toggle **Mouse Tooltip Translator** ON
5. **Important:** In Safari → Settings → Developer, check **"Allow Unsigned Extensions"**

> **Note:** "Allow Unsigned Extensions" resets when Safari restarts. You'll need to re-enable it each time.

### Option 2: Build from Source

```bash
git clone https://github.com/achiya-automation/safari-tooltip-translator.git
cd safari-tooltip-translator/xcode-project/Tooltip\ Translator
open Tooltip\ Translator.xcodeproj
```

In Xcode:
1. Select your Team in Signing & Capabilities
2. Click **Build & Run** (⌘R)
3. Enable the extension in Safari Settings → Extensions

## How It Works

The extension has three parts:

| Component | Role |
|-----------|------|
| **Content Script** | Detects hover/selection, shows tooltip |
| **Background Script** | Makes translation API calls (bypasses CSP) |
| **Popup** | Toggle on/off from the toolbar |

Translation is powered by Google Translate's free API. Text you hover over is sent to Google's servers for translation.

## Privacy

- The extension sends hovered/selected text to `translate.googleapis.com` for translation
- No data is stored, logged, or sent anywhere else
- No analytics, no tracking, no accounts
- The extension does not read input fields (passwords, forms, etc.)
- [Full Privacy Policy](PRIVACY.md)

## Requirements

- macOS 13 (Ventura) or later
- Safari 17 or later

## FAQ

**Q: Why do I need "Allow Unsigned Extensions"?**
A: Because this extension is distributed outside the App Store, it's not signed with an Apple Developer certificate. This setting tells Safari to trust it anyway.

**Q: Does the translation work offline?**
A: No, it requires an internet connection to reach Google Translate.

**Q: Can I change the target language?**
A: Currently it's hardcoded to Hebrew. A settings page for language selection is planned for a future version.

**Q: It's not working on a specific site?**
A: Open an [issue](https://github.com/achiya-automation/safari-tooltip-translator/issues) with the URL and a screenshot.

## Contributing

Pull requests are welcome! If you'd like to:
- Add support for more target languages
- Improve text detection
- Fix a bug

Please open an issue first to discuss the change.

## License

MIT License — see [LICENSE](LICENSE) for details.

## Credits

Built by [Achiya Automation](https://achiya-automation.com) — Business automation solutions.
