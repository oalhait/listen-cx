# listen.cx Raycast extension

Copy a Spotify or Apple Music track URL, then run **Create Listen.cx Link** in Raycast. The command immediately creates the short link and puts it straight on your clipboard.

Run **Add Song to Thread** to add that copied track to a listen.cx Thread. Enter the Thread URL once; the extension remembers it, so later additions only need the copied song URL and Command-Return (`⌘↵`).

## Develop locally

```sh
cd raycast/listen-cx
pnpm install
pnpm dev
```

Run `pnpm build` to validate the production bundle before publishing to the Raycast Store.
