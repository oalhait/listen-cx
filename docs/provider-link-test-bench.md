# Provider link test bench

The core contract is deliberately split into two layers:

1. The Worker must generate a short link, remember the receiver's provider,
   and render a user-tappable provider URL.
2. iOS and macOS must decide whether that provider URL opens the installed app
   or its web fallback. That decision is owned by the operating system and the
   provider, so it cannot be proved by Worker tests.

## Automated contract

`src/provider-links.test.ts` and `test/app.test.ts` cover the part we control:

- exact Apple Music destinations stay `https://music.apple.com/...` universal
  links; iTunes and geo hosts are normalized to that HTTPS host;
- Apple search fallbacks stay HTTPS and never use the undocumented `music:`
  scheme;
- exact Spotify destinations stay `https://open.spotify.com/...`, with an
  HTTPS search fallback when no catalog match exists;
- unsafe or missing stored destinations cannot become an anchor target;
- `POST /create`, the first provider choice, and a returning provider cookie
  all preserve the same destination intent;
- unfurl bot requests still receive the metadata page instead of a handoff.

Run with:

```sh
pnpm test
pnpm typecheck
```

## Device/provider verification

Use a real generated `https://listen.cx/<slug>` link and an installed,
signed-in provider app.

### iOS

1. Open the link from Messages, Mail, or another app and choose Apple Music.
2. Confirm the handoff page's button is a normal `https://music.apple.com/...`
   link and tapping it opens the matching song in Music.
3. If universal-link behavior is ambiguous, paste the destination into Notes,
   long-press it, and choose the app/browser option. On iOS with Developer Mode,
   Settings → Developer → Associated Domains Development → Diagnostics can
   validate the installed app's universal-link association.
4. Repeat with Spotify and confirm the matching track opens in Spotify.

### macOS

1. Open the generated link in Safari or Chrome and choose Apple Music.
2. Confirm the button opens the matching track in Music; if the app is absent,
   the HTTPS URL must remain usable in the Apple Music web player.
3. Control-click the Apple destination in Notes to inspect the app/browser
   choices, then repeat with Spotify.

Typing a URL directly into a browser address bar is not a valid universal-link
test: the browser treats that as direct navigation. Provider sign-in,
subscription, app installation, storefront availability, browser choice, and
OS association state remain manual test variables.
