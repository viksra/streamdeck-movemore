# Elgato Marketplace listing

What was entered in [Maker Console](https://maker.elgato.com) for Move More (submitted for review with 1.5.4). The images in this folder are sized for it.

## Organization

- **Name and handle:** viksra (matches the plugin ID `com.viksra.movemore` and the plugin's Author field)
- **Support link:** https://github.com/viksra/streamdeck-movemore/issues

## Create product

1. **Product type:** Plugin
2. **Upload your plugin:** `release/com.viksra.movemore.streamDeckPlugin` (built with `npm run pack`). Maker Console reads the name, ID, version and requirements from the manifest and needs SDK version 3 or later, which turns on DRM (see the README's Development section).
3. **What's your product?**
   - **Name:** Move More (taken from the manifest; can't be changed later)
   - **Description:**

     Move More is a layout editor for Stream Deck that lets you select several keys at once and move them together: around a page, to another page, or into a folder. The Stream Deck app only lets you drag one key at a time; Move More opens an editor in your browser with multi-select, drag and drop with a live preview, cut and paste, search, zoom, and page management (add, reorder and delete pages).

     Nothing changes until you click Apply. Move More then backs up the whole profile, checks that you haven't moved keys in Stream Deck in the meantime, briefly closes Stream Deck, writes the new layout and starts Stream Deck again. Any change can be undone from Backups in the editor. Go to Page and Switch Profile keys are renumbered so they keep opening the same page, and custom key images move with their keys.

     The editor follows Stream Deck: it opens on the profile your deck is showing, switches when you switch profiles, and shows changes you make in the Stream Deck app.

     Requires Windows 10 or 11 and Stream Deck 7.0 or later. Moves keypad keys; dials and touch strips are kept in place. Free and open source (MIT).

4. **Details about your product**
   - **Language:** English
   - **Type:** Utilities
   - **Price:** Free (can't be switched to paid after submitting)
   - **Additional links** (Maker Console offers fixed types only, none for donations, so Buy Me a Coffee stays on GitHub):
     - Support: https://github.com/viksra/streamdeck-movemore/issues
     - Setup Guide: https://github.com/viksra/streamdeck-movemore#readme
     - Legal: https://github.com/viksra/streamdeck-movemore/blob/main/LICENSE
     - Community: https://github.com/viksra/streamdeck-movemore
5. **Upload media**
   - **Icon:** `app-icon.png` (288 × 288)
   - **Thumbnail:** `thumbnail.png` (1920 × 960)
   - **Gallery:** `gallery-1.png` to `gallery-4.png` (1920 × 960). Add them one at a time in that order: the gallery keeps the order they arrive in and can't be reordered in the wizard.
6. **Submit for review**
   - **Release notes (1.5.4):** First release on Elgato Marketplace. Select several keys and move them together, across pages and into folders, with a backup before every change, conflict checks, and live updates from Stream Deck.
   - **Automatically publish after being approved:** off, to test the DRM-protected build first: download it from the product's Versions tab once approved, install it, check the editor and an Apply, then publish.
