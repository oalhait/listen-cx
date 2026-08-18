export const DESIGN_TOKENS = `
  :root {
    color-scheme: dark;
    --ls-night: #0b171a;
    --ls-deep: #10272d;
    --ls-panel: #142f36;
    --ls-panel-strong: #193b43;
    --ls-paper: #f1eee5;
    --ls-coral: #ff8068;
    --ls-ice: #9edbd7;
    --ls-violet: #afa1ff;
    --ls-muted: #9bb0ad;
    --ls-faint: #687d7e;
    --ls-line: rgba(241,238,229,.16);
    --ls-line-strong: rgba(241,238,229,.28);
    --ls-plastic: rgba(241,238,229,.08);
    --ls-plastic-edge: rgba(241,238,229,.42);
    --ls-disc: #111b1d;
    --ls-disc-label: #d8d4c6;
    --ls-focus: #ffc0b1;
    --ls-danger: #ff9a91;
    --ls-serif: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
    --ls-sans: "Avenir Next", "Helvetica Neue", system-ui, sans-serif;
    --ls-mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
    --ls-radius: 14px;
  }
  *,*::before,*::after { box-sizing:border-box; }
  button,input,a { font:inherit; }
  button,a { -webkit-tap-highlight-color:transparent; }
  ::selection { background:var(--ls-coral); color:var(--ls-night); }
`;
