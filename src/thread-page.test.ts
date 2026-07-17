import { describe, expect, it } from "vitest";
import { homePage } from "./page.js";
import {
  threadCreationPage,
  threadPage,
  type ThreadPageModel,
} from "./thread-page.js";

const PUBLIC_URL = "https://listen.cx/t/threadabc";
const SONG_URL = "https://listen.cx/song123";

function model(overrides: Partial<ThreadPageModel> = {}): ThreadPageModel {
  return {
    title: "Friday drive",
    publicUrl: PUBLIC_URL,
    state: "open",
    managed: false,
    actions: {
      add: "/api/threads/threadabc/contributions",
      activateManagement: "/t/threadabc/manage/activate",
    },
    songs: [
      {
        contributionId: "contribution-1",
        title: "Kingston",
        artist: "Faye Webster",
        artworkUrl: "https://images.example/kingston.jpg",
        canonicalUrl: SONG_URL,
      },
    ],
    ...overrides,
  };
}

describe("threadCreationPage", () => {
  it("renders an accessible title form and runtime-only success actions", () => {
    const html = threadCreationPage({
      createAction: "/api/threads",
      initialTitle: "Road trip",
    });

    expect(html).toContain('action="/api/threads"');
    expect(html).toContain('label for="thread-title"');
    expect(html).toContain('value="Road trip"');
    expect(html).toContain("Create Thread");
    expect(html).toContain("Share Thread");
    expect(html).toContain("Save private management link");
    expect(html).toContain("Anyone with this private link can remove songs or close the Thread.");
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("data.managementUrl");
    expect(html).toContain('copied?"success":"error"');
    expect(html).not.toContain("#manage=");
  });

  it("preserves and escapes a failed title without injecting markup", () => {
    const html = threadCreationPage({
      createAction: "/api/threads",
      initialTitle: 'Road <script>alert("x")</script>',
      status: { tone: "error", message: 'Couldn\'t create <b>this</b> Thread.' },
    });

    expect(html).toContain('value="Road &#60;script&#62;alert(&#34;x&#34;)&#60;/script&#62;"');
    expect(html).toContain("Couldn&#39;t create &#60;b&#62;this&#60;/b&#62; Thread.");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<b>this</b>");
  });
});

describe("threadPage", () => {
  it("renders a public open Thread with add, chronological Open, and Copy actions", () => {
    const html = threadPage(model());

    expect(html).toContain("Friday drive");
    expect(html).toContain('data-thread-state="open"');
    expect(html).toContain('action="/api/threads/threadabc/contributions"');
    expect(html).toContain('label for="song-url"');
    expect(html).toContain('href="https://listen.cx/song123"');
    expect(html).toContain("Open in my provider");
    expect(html).toContain('data-copy-song="https://listen.cx/song123"');
    expect(html).toContain('data-public-url="https://listen.cx/t/threadabc"');
    expect(html.indexOf("Kingston")).toBeLessThan(html.indexOf("Open in my provider"));
    expect(html).not.toContain("Remove Kingston");
    expect(html).not.toContain("data-close-action=");
  });

  it("renders an empty public Thread without losing the contribution action", () => {
    const html = threadPage(model({ songs: [] }));

    expect(html).toContain("No songs yet");
    expect(html).toContain("Add the first song");
    expect(html).toContain('id="add-song-form"');
  });

  it("preserves an entered song URL and presents a recoverable error", () => {
    const html = threadPage(
      model({
        addValue: "https://open.spotify.com/track/bad",
        status: { tone: "error", message: "That track could not be resolved. Try again." },
      }),
    );

    expect(html).toContain('value="https://open.spotify.com/track/bad"');
    expect(html).toContain("That track could not be resolved. Try again.");
    expect(html).toContain('data-tone="error"');
    expect(html).toContain('aria-live="polite"');
  });

  it("renders public full and closed states without an add form", () => {
    const full = threadPage(model({ state: "full" }));
    const closed = threadPage(model({ state: "closed" }));

    expect(full).toContain("This Thread is full");
    expect(full).not.toContain('id="add-song-form"');
    expect(full).toContain("Open in my provider");
    expect(closed).toContain("Contributions are closed");
    expect(closed).not.toContain('id="add-song-form"');
    expect(closed).toContain("Copy song link");
  });

  it("renders managed open controls without exposing private authority", () => {
    const html = threadPage(
      model({
        managed: true,
        actions: {
          add: "/api/threads/threadabc/contributions",
          activateManagement: "/t/threadabc/manage/activate",
          close: "/t/threadabc/manage/close",
        },
        songs: [
          {
            ...model().songs[0]!,
            removeAction: "/t/threadabc/manage/contributions/contribution-1/remove",
          },
        ],
      }),
    );

    expect(html).toContain("Private management view");
    expect(html).toContain("Remove Kingston");
    expect(html).toContain('data-remove-action="/t/threadabc/manage/contributions/contribution-1/remove"');
    expect(html).toContain("Close contributions");
    expect(html).toContain('data-close-action="/t/threadabc/manage/close"');
    expect(html).toContain('data-public-url="https://listen.cx/t/threadabc"');
    expect(html).not.toContain("managementUrl");
    expect(html).not.toMatch(/#manage=[A-Za-z0-9_-]+/);
  });

  it("lets a managed full Thread remove songs but keeps a managed closed Thread closed", () => {
    const managedSong = {
      ...model().songs[0]!,
      removeAction: "/t/threadabc/manage/contributions/contribution-1/remove",
    };
    const managedActions = {
      add: "/api/threads/threadabc/contributions",
      activateManagement: "/t/threadabc/manage/activate",
      close: "/t/threadabc/manage/close",
    };
    const full = threadPage(
      model({ state: "full", managed: true, songs: [managedSong], actions: managedActions }),
    );
    const closed = threadPage(
      model({ state: "closed", managed: true, songs: [managedSong], actions: managedActions }),
    );

    expect(full).toContain("Remove Kingston");
    expect(full).toContain("Remove a song to make room");
    expect(full).not.toContain('id="add-song-form"');
    expect(closed).toContain("Remove Kingston");
    expect(closed).toContain("This cannot be reopened");
    expect(closed).not.toContain("data-close-action=");
    expect(closed).not.toContain('id="add-song-form"');
  });

  it("posts fragment activation, scrubs the fragment, and leaves invalid activation public", () => {
    const html = threadPage(model());

    expect(html).toContain('location.hash.startsWith("#manage=")');
    expect(html).toContain('fetch(activationAction');
    expect(html).toContain('method:"POST"');
    expect(html).toContain('history.replaceState(null,"",cleanUrl)');
    expect(html).toContain("That private management link is invalid or no longer available.");
    expect(html).toContain("if(response.ok){location.reload();return;}");
    expect(html).toContain('copied?"success":"error"');
  });

  it("uses noindex, no-referrer, system fonts, reduced motion, and 48px controls", () => {
    const html = threadPage(model());

    expect(html).toContain('<meta name="robots" content="noindex,nofollow,noarchive">');
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
    expect(html).toContain("system-ui");
    expect(html).not.toContain("fonts.googleapis.com");
    expect(html).toContain("min-height:48px");
    expect(html).toContain("prefers-reduced-motion:reduce");
    expect(html).toContain('aria-label="Songs in chronological order"');
  });

  it("escapes every supplied string and excludes secrets from OG and error output", () => {
    const html = threadPage(
      model({
        title: '<img src=x onerror="secret-token">',
        status: { tone: "error", message: '<script>secret-token</script>' },
        songs: [
          {
            contributionId: 'id" onclick="secret-token',
            title: "<b>secret-token</b>",
            artist: 'Artist & "friend"',
            artworkUrl: 'https://images.example/a.jpg?x="secret-token',
            canonicalUrl: 'https://listen.cx/song?x="secret-token',
          },
        ],
      }),
    );

    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>secret-token</script>");
    expect(html).not.toContain("<b>secret-token</b>");
    expect(html).toContain("&#60;b&#62;secret-token&#60;/b&#62;");
    expect(html).toContain("Artist &#38; &#34;friend&#34;");
  });
});

describe("homePage", () => {
  it("keeps the one-song primary action and adds a secondary Thread entry", () => {
    const html = homePage("https://listen.cx");

    expect(html).toContain("Paste a song");
    expect(html).toContain("Make my link");
    expect(html).toContain('href="/threads/new"');
    expect(html).toContain("Start a Thread");
  });
});
