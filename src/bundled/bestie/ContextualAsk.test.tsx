// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createRelaySession,
  type RelaySession,
} from "../../features/relay/session";
import {
  readLinkedChat,
  linkedDraftKey,
} from "../../features/solo/linked-chat";
import {
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import {
  AskBestieAction,
  CatchUpBestieAction,
  CatchUpRequestMessage,
  ContextualAskPanel,
  catchUpRequestSummary,
  contextualAskTarget,
  contextualCatchUpTarget,
  fileCatchUpChat,
  parseContextualAskTarget,
  parseContextualCatchUpTarget,
} from "./ContextualAsk";
import { readView, writeView } from "../../shared/view-state";
import type { RelayData } from "../../features/relay/service";
import type { UnreadSnapshot } from "../../features/relay/unread";
import { mentionDraft } from "../../features/messages/mention-draft";
import type { Panels } from "../../features/panels/service";
import { PanelWorkspace } from "../../features/panels/PanelWorkspace";

const hookState = vi.hoisted(() => ({
  saved: {
    read: true,
    agent: "b".repeat(64) as string | undefined,
    error: undefined,
  },
  choices: {
    selectable: [
      {
        pubkey: "b".repeat(64),
        name: "Relay name",
        managedName: "Pollen",
        managed: true,
      },
    ],
    identities: [],
    definitions: [],
    archives: { status: "ready", archived: [] },
    templates: {
      status: "ready",
      identities: [],
      complete: true,
      pending: false,
    },
    status: "ready",
    complete: true,
    pending: false,
  },
}));

vi.mock("../../features/solo/default-agent", async (original) => {
  const actual =
    await original<typeof import("../../features/solo/default-agent")>();
  return { ...actual, useSavedAgentState: () => hookState.saved };
});
vi.mock("../../features/agents/use-choices", () => ({
  useAgentChoices: () => hookState.choices,
}));

const owner = createRelaySession(null);
afterAll(() => owner.dispose());
afterEach(() => {
  cleanup();
  localStorage.clear();
  hookState.saved.agent = "b".repeat(64);
  hookState.choices.selectable.splice(0, Infinity, {
    pubkey: "b".repeat(64),
    name: "Relay name",
    managedName: "Pollen",
    managed: true,
  });
  hookState.choices.status = "ready";
  hookState.choices.complete = true;
  hookState.choices.pending = false;
  hookState.choices.archives.status = "ready";
  startChat.mockClear();
  vi.restoreAllMocks();
});

const viewer = "a".repeat(64);
const scope = `https://relay.test:${viewer}`;
const contextualDraftKey = (source: string, agent: string) =>
  linkedDraftKey(`${source}:bestie:${agent}`);
const message = {
  id: "c".repeat(64),
  channelId: "design",
  authorId: viewer,
  content: "Please review this",
  createdAt: 1,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 0,
};
const startChat = vi.fn();
const session = {
  ...owner.session,
  viewer,
  scope,
  channelWrites: {
    ...owner.session.channelWrites,
    available: true,
    start: startChat,
  },
  outbox: {
    ...owner.session.outbox,
    supports: () => true,
  },
} as RelaySession;

const personalCatchUp =
  "Lead with the few things most relevant to me based on what you know about my priorities, work, and people, and briefly say why. If you lack that context, prioritize decisions, direct asks, risks, blockers, and meaningful changes. Summarize everything else at a very high level. Link the important sources, and skip the play-by-play unless I ask.";
const progressUpdate =
  "If you send a progress update before the result, use only “Taking a look now. I’ll let you know what I find.”";
const firstUnread = "d".repeat(64);
const latest = "e".repeat(64);
const firstUnreadLink = `buzz://message?channel=launch-planning&id=${firstUnread}`;
const latestLink = `buzz://message?channel=launch-planning&id=${latest}`;
const accessFallback =
  "First verify that you can read the channel and requested messages. Do not send a progress update before this check. If you cannot read them because you do not have access, reply with only “I don’t have access to [#Launch \\[planning\\]](buzz://channel/launch-planning). Add me to the channel, or paste the messages here for me to review.”";
const knownAccessFallback =
  "The current private channel roster does not include you. Do not inspect the source or send a progress update; reply with only “I don’t have access to [#Launch \\[planning\\]](buzz://channel/launch-planning). Add me to the channel, or paste the messages here for me to review.”";
const channelRequest = `Catch me up on [#Launch \\[planning\\]](buzz://channel/launch-planning), from [the first unread message](${firstUnreadLink}) through [the latest message at this moment](${latestLink})`;
const channelCatchUp = `@Pollen ${channelRequest}. ${accessFallback}. ${progressUpdate}. ${personalCatchUp}`;
const knownMissingChannelCatchUp = `@Pollen ${channelRequest}. ${knownAccessFallback}`;
const threadCatchUp = `@Pollen Read the entire [thread](${firstUnreadLink}), including its root and every reply, then catch me up. ${progressUpdate}. ${personalCatchUp}`;

it("round-trips only exact contextual Ask targets", () => {
  const value = { source: "c".repeat(64), agent: "b".repeat(64) };
  expect(parseContextualAskTarget(contextualAskTarget(value))).toEqual(value);
  expect(
    parseContextualAskTarget("buzz://bestie/ask?source=bad&agent=bad"),
  ).toBe(undefined);
  expect(
    parseContextualAskTarget(`${contextualAskTarget(value)}&extra=true`),
  ).toBe(undefined);
  expect(
    parseContextualAskTarget(`${contextualAskTarget(value)}#unexpected`),
  ).toBe(undefined);
});

it("round-trips only exact frozen catch-up targets", () => {
  const thread = {
    thread: "c".repeat(64),
    agent: "b".repeat(64),
  };
  expect(parseContextualCatchUpTarget(contextualCatchUpTarget(thread))).toEqual(
    thread,
  );
  expect(
    parseContextualCatchUpTarget(
      `${contextualCatchUpTarget(thread)}&extra=true`,
    ),
  ).toBeUndefined();
  const value = {
    channel: "design",
    oldest: "c".repeat(64),
    latest: "d".repeat(64),
    agent: "b".repeat(64),
  };
  expect(parseContextualCatchUpTarget(contextualCatchUpTarget(value))).toEqual(
    value,
  );
  expect(
    parseContextualCatchUpTarget(
      `${contextualCatchUpTarget(value)}&latest=${"e".repeat(64)}`,
    ),
  ).toBeUndefined();
  expect(
    parseContextualCatchUpTarget(
      contextualCatchUpTarget({ ...value, channel: "bad\nchannel" }),
    ),
  ).toBeUndefined();
  const recent = {
    channel: "design",
    since: 1_700_000_000,
    latest: "d".repeat(64),
    agent: "b".repeat(64),
  };
  expect(parseContextualCatchUpTarget(contextualCatchUpTarget(recent))).toEqual(
    recent,
  );
  expect(
    parseContextualCatchUpTarget(
      `${contextualCatchUpTarget(recent)}&oldest=${"c".repeat(64)}`,
    ),
  ).toBeUndefined();
});

it("recognizes only generated catch-up prompts and gives them compact labels", () => {
  expect(catchUpRequestSummary(channelCatchUp)).toBe(
    "Catch me up on #Launch [planning] · unread → now",
  );
  expect(catchUpRequestSummary(knownMissingChannelCatchUp)).toBe(
    "Catch me up on #Launch [planning] · unread → now",
  );
  expect(
    catchUpRequestSummary(`@Pollen ${channelRequest}. ${personalCatchUp}`),
  ).toBe("Catch me up on #Launch [planning] · unread → now");
  expect(catchUpRequestSummary(threadCatchUp)).toBe(
    "Catch me up on this thread",
  );
  expect(
    catchUpRequestSummary(
      `@Pollen Catch me up on [#Design](buzz://channel/design), using [the unread message](${latestLink}). ${personalCatchUp}`,
    ),
  ).toBe("Catch me up on #Design · unread message");
  expect(
    catchUpRequestSummary(
      `@Pollen Catch me up on [#Design](buzz://channel/design), covering the two days since \`2026-11-14T17:00:00.000Z\` through [the latest message at this moment](${latestLink}). ${personalCatchUp}`,
    ),
  ).toBe("Catch me up on #Design · last 2 days");
  expect(catchUpRequestSummary(`Please ${channelCatchUp}`)).toBeUndefined();
  expect(
    catchUpRequestSummary(channelCatchUp.replace(latest, "not-an-event")),
  ).toBeUndefined();
  expect(
    catchUpRequestSummary(
      channelCatchUp.replace(personalCatchUp, "Summarize."),
    ),
  ).toBeUndefined();
});

it("collapses a generated request until its owner asks to see it", async () => {
  const open = vi.fn(() => true);
  render(
    <CatchUpRequestMessage
      message={{
        ...message,
        content: channelCatchUp,
        mentions: ["b".repeat(64)],
      }}
      canOpen={() => true}
      open={open}
    />,
  );
  expect(
    screen.getByText("Catch me up on #Launch [planning] · unread → now"),
  ).toBeVisible();
  expect(screen.getByText("Show request")).toBeVisible();
  expect(screen.queryByText(/Lead with the few things/)).toBeNull();

  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", {
      name: /Catch me up on #Launch \[planning\].*Show request/,
    }),
  );
  expect(screen.getByText("Hide request")).toBeVisible();
  expect(screen.getByText(/Lead with the few things/)).toBeVisible();
  await user.click(
    screen.getByRole("link", { name: "the first unread message" }),
  );
  expect(open).toHaveBeenCalledWith(firstUnreadLink);
});

it("offers Catch me up only in the left-nav row and captures its unread cut before opening", async () => {
  vi.spyOn(Date, "now").mockReturnValue(new Date(2026, 10, 11, 12).getTime());
  const channel = {
    id: "launch-planning",
    name: "Launch [planning]",
    channelType: "stream" as const,
    private: true as const,
    members: [viewer],
    space: "collaborative" as const,
  };
  let currentChannel = channel;
  const oldest = "d".repeat(64);
  const latest = "e".repeat(64);
  const unread: UnreadSnapshot = {
    ...session.unread.snapshot({ kind: "channel", channelId: channel.id }),
    observedCount: 2,
    attentionCount: 0,
    coverage: "observed" as const,
    freshness: "observed" as const,
    oldestUnreadId: oldest,
    latestMessage: { id: latest, createdAt: 2 },
  };
  let currentUnread = unread;
  const markChannelRead = vi.fn();
  const catchUpSession = {
    ...session,
    channels: {
      ...session.channels,
      list: () => ({ status: "ready" as const, channels: [currentChannel] }),
      subscribeList: () => () => {},
    },
    unread: {
      ...session.unread,
      snapshot: () => currentUnread,
      subscribe: () => () => {},
      markChannelRead,
    },
  } as RelaySession;
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    scope,
    origin: "https://relay.test",
    viewer,
    session: catchUpSession,
  };
  const relay = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    tryAgain() {},
    disconnect() {},
    clearCache: async () => {},
  } satisfies RelayData;
  const requestOpen = vi.fn<Panels["requestOpen"]>(() => true);
  const panels = {
    resolve: () => ({ id: "contextual-ask" }),
    requestOpen,
  } as unknown as Panels;
  const close = vi.fn();
  const menu = () => (
    <ToastProvider>
      <MenuRoot>
        <MenuTrigger>Channel actions</MenuTrigger>
        <MenuPopup>
          <CatchUpBestieAction
            row={{
              id: channel.id,
              kind: "team",
              label: channel.name,
              sectionKey: "channels",
              channel,
              unread: currentUnread,
            }}
            session={catchUpSession}
            target={{
              version: 1,
              kind: "conversation",
              channelId: "current-channel",
              scope: {
                communityOrigin: "https://relay.test",
                viewer,
              },
            }}
            available={() => true}
            close={close}
            relay={relay}
            panels={panels}
          />
        </MenuPopup>
      </MenuRoot>
    </ToastProvider>
  );
  render(menu());
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Channel actions" }));
  const item = await screen.findByRole("menuitem", { name: "Catch me up" });
  expect(item.querySelector(".buzz-avatar")).toBeInTheDocument();
  fireEvent.click(item);

  expect(requestOpen).toHaveBeenCalledOnce();
  const opening = requestOpen.mock.calls[0]?.[0];
  expect(opening?.channelId).toBe("current-channel");
  const target = parseContextualCatchUpTarget(opening?.target ?? "");
  expect(target).toEqual({
    channel: channel.id,
    oldest,
    latest,
    agent: "b".repeat(64),
  });
  const sourceId = `catch-up:${channel.id}:${oldest}:${latest}`;
  const key = contextualDraftKey(sourceId, "b".repeat(64));
  expect(readLinkedChat(scope, key)).toEqual({
    channelId: channel.id,
    link: `buzz://channel/${channel.id}`,
  });
  const draft = mentionDraft(readView(scope, `${key}:new-draft`, null));
  expect(draft.recipients).toEqual([
    expect.objectContaining({ pubkey: "b".repeat(64), name: "Pollen" }),
  ]);
  expect(draft.text).not.toContain("few things most relevant to me");
  expect(draft.text).toContain(
    "The current private channel roster does not include you. Do not inspect the source or send a progress update",
  );
  expect(draft.text).toContain(
    "reply with only “I don’t have access to [#Launch \\[planning\\]](buzz://channel/launch-planning). Add me to the channel, or paste the messages here for me to review.”",
  );
  expect(draft.text).toContain(
    `buzz://message?channel=${channel.id}&id=${oldest}`,
  );
  expect(draft.text).toContain(
    `buzz://message?channel=${channel.id}&id=${latest}`,
  );
  expect(readView(scope, `${key}:submit-request`, null)).toBe(opening?.target);
  expect(readView(scope, `${key}:settings`, null)).toEqual({
    name: "Launch [planning] · Nov 11",
    ttlSeconds: 604800,
    lifetimeChosen: true,
  });
  expect(close).toHaveBeenCalledOnce();
  expect(markChannelRead).not.toHaveBeenCalled();
  expect(startChat).not.toHaveBeenCalled();

  cleanup();
  localStorage.clear();
  requestOpen.mockClear();
  close.mockClear();
  const now = 2_000_000_000;
  vi.spyOn(Date, "now").mockReturnValue(now * 1000);
  currentChannel = {
    ...channel,
    members: [viewer, "b".repeat(64)],
  };
  currentUnread = {
    target: unread.target,
    observedCount: 0,
    attentionCount: 0,
    coverage: "observed",
    freshness: "observed",
    manual: "none",
    latestMessage: { id: latest, createdAt: now - 60 },
  };
  render(menu());
  const recentUser = userEvent.setup();
  await recentUser.click(
    screen.getByRole("button", { name: "Channel actions" }),
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Catch me up" }));
  const recentOpening = requestOpen.mock.calls[0]?.[0];
  expect(parseContextualCatchUpTarget(recentOpening?.target ?? "")).toEqual({
    channel: channel.id,
    since: now - 2 * 86_400,
    latest,
    agent: "b".repeat(64),
  });
  const recentKey = contextualDraftKey(
    `catch-up:${channel.id}:recent:${latest}`,
    "b".repeat(64),
  );
  const recentDraft = mentionDraft(
    readView(scope, `${recentKey}:new-draft`, null),
  );
  expect(recentDraft.text).toContain(
    new Date((now - 2 * 86_400) * 1000).toISOString(),
  );
  expect(recentDraft.text).toContain("few things most relevant to me");
  expect(recentDraft.text).toContain(
    "Do not send a progress update before this check",
  );
  expect(recentDraft.text).toContain(
    "Taking a look now. I’ll let you know what I find.",
  );

  cleanup();
  currentUnread = {
    ...currentUnread,
    latestMessage: { id: latest, createdAt: now - 2 * 86_400 - 1 },
  };
  render(menu());
  const quietUser = userEvent.setup();
  await quietUser.click(
    screen.getByRole("button", { name: "Channel actions" }),
  );
  await screen.findByRole("menu");
  expect(screen.queryByRole("menuitem", { name: "Catch me up" })).toBeNull();
});

it("offers the exact saved Bestie and seeds an automatic whole-thread catch-up", async () => {
  vi.spyOn(Date, "now").mockReturnValue(new Date(2026, 10, 11, 12).getTime());
  const open = vi.fn<(target: string) => boolean>(() => true);
  const dispose = vi.fn();
  const thread = vi.spyOn(session, "thread").mockReturnValue({
    snapshot: () => ({ root: { ...message, content: "Launch plan" } }),
    dispose,
  } as unknown as ReturnType<RelaySession["thread"]>);
  const reply = {
    ...message,
    id: "f".repeat(64),
    threadRootId: message.id,
    replyParentId: message.id,
  };
  render(
    <ToastProvider>
      <MenuRoot>
        <MenuTrigger>Message actions</MenuTrigger>
        <MenuPopup>
          <AskBestieAction
            message={reply}
            session={session}
            close={() => {}}
            canOpen={() => true}
            open={open}
          />
        </MenuPopup>
      </MenuRoot>
    </ToastProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Message actions" }));
  const item = await screen.findByRole("menuitem", { name: "Catch me up" });
  expect(item).toHaveTextContent("Catch me up");
  fireEvent.click(item);
  // Menu-hosted contributions retire as selection closes the menu. Opening
  // must finish in this click instead of depending on an async continuation.
  expect(open).toHaveBeenCalledOnce();
  const target = parseContextualCatchUpTarget(open.mock.calls[0]?.[0] ?? "");
  expect(target?.agent).toBe("b".repeat(64));
  expect(target).toEqual({ thread: message.id, agent: "b".repeat(64) });
  expect(
    readLinkedChat(scope, contextualDraftKey(message.id, "b".repeat(64))),
  ).toEqual({
    channelId: "design",
    link: `buzz://message?channel=design&id=${message.id}`,
  });
  const key = contextualDraftKey(message.id, "b".repeat(64));
  const draft = mentionDraft(readView(scope, `${key}:new-draft`, null));
  expect(draft.text).toContain("Read the entire");
  expect(draft.text).toContain("including its root and every reply");
  expect(draft.text).toContain("few things most relevant to me");
  expect(draft.text).toContain(
    "Taking a look now. I’ll let you know what I find.",
  );
  expect(readView(scope, `${key}:submit-request`, null)).toBe(
    open.mock.calls[0]?.[0],
  );
  expect(readView(scope, `${key}:settings`, null)).toEqual({
    name: "Launch plan · Nov 11",
    ttlSeconds: 604800,
    lifetimeChosen: true,
  });
  expect(thread).toHaveBeenCalledWith("design", message.id);
  expect(dispose).toHaveBeenCalledOnce();
  expect(startChat).not.toHaveBeenCalled();
});

it("replaces the fallback panel title with the seeded catch-up topic", async () => {
  const key = contextualDraftKey(message.id, "b".repeat(64));
  writeView(scope, key, {
    channelId: "design",
    link: `buzz://message?channel=design&id=${message.id}`,
  });
  writeView(scope, `${key}:settings`, {
    name: "Launch plan · Nov 11",
  });
  const none: readonly never[] = [];
  const contributions = { snapshot: () => none, subscribe: () => () => {} };
  const relaySnapshot = {
    status: "ready" as const,
    generation: 1,
    scope,
    origin: "https://relay.test",
    viewer,
    session,
  };
  const relay = {
    snapshot: () => relaySnapshot,
    subscribe: () => () => {},
    retry() {},
    tryAgain() {},
    disconnect() {},
    clearCache: async () => {},
  } satisfies RelayData;
  render(
    <ToastProvider>
      <PanelWorkspace
        value="catch-up"
        select={() => {}}
        items={[
          {
            id: "catch-up",
            label: "Bestie chat",
            content: (
              <ContextualAskPanel
                target={contextualAskTarget({
                  source: message.id,
                  agent: "b".repeat(64),
                })}
                close={() => {}}
                relay={relay}
                host={{} as never}
                extensions={{ tools: contributions, inline: contributions }}
              />
            ),
          },
        ]}
      />
    </ToastProvider>,
  );
  expect(
    await screen.findByRole("tab", { name: "Launch plan · Nov 11" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("tab", { name: "Bestie chat" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Close chat with Pollen" }),
  ).toBeNull();
  expect(document.querySelectorAll("header.panel-header")).toHaveLength(1);
});

it.each([
  {
    label: "creates Catch me up when the catch-up chat starts",
    sections: [],
    expected: "create",
  },
  {
    label: "reuses an existing Catch me up workspace",
    sections: [{ id: "existing", name: "Catch me up" }],
    expected: "assign",
    thread: false,
  },
  {
    label: "files a thread catch-up in an existing Catch me up workspace",
    sections: [{ id: "existing", name: "Catch me up" }],
    expected: "assign",
    thread: true,
  },
  {
    label: "reuses the legacy Catch-ups workspace without rename support",
    sections: [{ id: "existing", name: "Catch-ups" }],
    expected: "assign",
    thread: false,
  },
])("$label", async ({ sections, expected }) => {
  const channelId = crypto.randomUUID();
  const ensure = vi.fn(async () => {});
  const data = {
    sections: sections.map((section, order) => ({ ...section, order })),
    assignments: {},
    starred: [],
    muted: [],
  };
  const createAndAssign = vi.fn(async () => data);
  const assign = vi.fn(async () => data);
  const renameSection = vi.fn(async () => {
    throw new Error("Section rename is unavailable");
  });
  const preferencesSnapshot = {
    status: "ready" as const,
    data,
  };
  const catchUpSession = {
    ...session,
    soloPreferences: {
      ...session.soloPreferences,
      ensure,
      snapshot: () => preferencesSnapshot,
      createAndAssign,
      assign,
      renameSection,
    },
  } as unknown as RelaySession;
  await fileCatchUpChat(catchUpSession, channelId);
  if (expected === "create")
    expect(createAndAssign).toHaveBeenCalledWith(channelId, {
      id: "bestie-catch-ups",
      name: "Catch me up",
    });
  else expect(assign).toHaveBeenCalledWith(channelId, "existing");
  expect(renameSection).not.toHaveBeenCalled();
  expect(ensure).toHaveBeenCalledOnce();
});

it("does not move an existing catch-up back after the owner re-files it", async () => {
  const channelId = crypto.randomUUID();
  const sourceId = message.id;
  const key = contextualDraftKey(sourceId, "b".repeat(64));
  writeView(scope, `${key}:started-chat`, channelId);
  writeView(scope, `${key}:source`, {
    channelId: message.channelId,
    link: `buzz://message?channel=${message.channelId}&id=${message.id}`,
  });
  const ensure = vi.fn(async () => {});
  const assign = vi.fn(async () => {});
  const createAndAssign = vi.fn(async () => {});
  const loadingChannels = {
    status: "loading" as const,
    channels: [],
  };
  const preferencesSnapshot = {
    status: "ready" as const,
    data: {
      sections: [
        { id: "catch-ups", name: "Catch me up", order: 0 },
        { id: "mine", name: "My workspace", order: 1 },
      ],
      assignments: { [channelId]: "mine" },
      starred: [],
      muted: [],
    },
  };
  const catchUpSession = {
    ...session,
    channels: {
      ...session.channels,
      list: () => loadingChannels,
      subscribeList: () => () => {},
    },
    soloPreferences: {
      ...session.soloPreferences,
      ensure,
      snapshot: () => preferencesSnapshot,
      assign,
      createAndAssign,
    },
  } as unknown as RelaySession;
  const relaySnapshot = {
    status: "ready" as const,
    generation: 1,
    scope,
    origin: "https://relay.test",
    viewer,
    session: catchUpSession,
  };
  const relay = {
    snapshot: () => relaySnapshot,
    subscribe: () => () => {},
    retry() {},
    tryAgain() {},
    disconnect() {},
    clearCache: async () => {},
  } satisfies RelayData;
  const none: readonly never[] = [];
  const contributions = { snapshot: () => none, subscribe: () => () => {} };
  render(
    <ToastProvider>
      <ContextualAskPanel
        target={contextualCatchUpTarget({
          thread: sourceId,
          agent: "b".repeat(64),
        })}
        close={() => {}}
        relay={relay}
        host={{} as never}
        extensions={{ tools: contributions, inline: contributions }}
      />
    </ToastProvider>,
  );
  expect(await screen.findByText("Opening your chat…")).toBeInTheDocument();
  expect(ensure).not.toHaveBeenCalled();
  expect(assign).not.toHaveBeenCalled();
  expect(createAndAssign).not.toHaveBeenCalled();
});

it.each([
  { label: "deleted", archived: false },
  { label: "archived", archived: true },
])("restarts a catch-up whose saved chat was $label", async ({ archived }) => {
  const channelId = crypto.randomUUID();
  const sourceId = message.id;
  const key = contextualDraftKey(sourceId, "b".repeat(64));
  const startedKey = `${key}:started-chat`;
  writeView(scope, startedKey, channelId);
  writeView(scope, `${key}:source`, {
    channelId: message.channelId,
    link: `buzz://message?channel=${message.channelId}&id=${message.id}`,
  });
  const channelSnapshot = {
    status: "ready" as const,
    channels: archived
      ? [
          {
            id: channelId,
            name: "Old catch-up",
            channelType: "solo" as const,
            members: [viewer, "b".repeat(64)],
            archived: true,
          },
        ]
      : [],
  };
  const catchUpSession = {
    ...session,
    channels: {
      ...session.channels,
      list: () => channelSnapshot,
      subscribeList: () => () => {},
    },
  } as unknown as RelaySession;
  const relaySnapshot = {
    status: "ready" as const,
    generation: 1,
    scope,
    origin: "https://relay.test",
    viewer,
    session: catchUpSession,
  };
  const relay = {
    snapshot: () => relaySnapshot,
    subscribe: () => () => {},
    retry() {},
    tryAgain() {},
    disconnect() {},
    clearCache: async () => {},
  } satisfies RelayData;
  const none: readonly never[] = [];
  const contributions = { snapshot: () => none, subscribe: () => () => {} };
  render(
    <ToastProvider>
      <ContextualAskPanel
        target={contextualCatchUpTarget({
          thread: sourceId,
          agent: "b".repeat(64),
        })}
        close={() => {}}
        relay={relay}
        host={{} as never}
        extensions={{ tools: contributions, inline: contributions }}
      />
    </ToastProvider>,
  );
  expect(
    await screen.findByRole("form", { name: "Send a message to this chat" }),
  ).toBeInTheDocument();
  expect(readView(scope, startedKey, null)).toBeNull();
  expect(screen.queryByText("Opening your chat…")).toBeNull();
});

it("does not resume a former Bestie's chat for the same source", async () => {
  const source = {
    channelId: message.channelId,
    link: `buzz://message?channel=design&id=${message.id}`,
  };
  writeView(
    scope,
    `${contextualDraftKey(message.id, "b".repeat(64))}:started-chat`,
    crypto.randomUUID(),
  );
  writeView(scope, contextualDraftKey(message.id, "d".repeat(64)), null);
  hookState.saved.agent = "d".repeat(64);
  hookState.choices.selectable.splice(0, Infinity, {
    pubkey: "d".repeat(64),
    name: "Relay name",
    managedName: "Honey",
    managed: true,
  });
  const open = vi.fn<(target: string) => boolean>(() => true);
  render(
    <ToastProvider>
      <MenuRoot>
        <MenuTrigger>Message actions</MenuTrigger>
        <MenuPopup>
          <AskBestieAction
            message={message}
            session={session}
            close={() => {}}
            canOpen={() => true}
            open={open}
          />
        </MenuPopup>
      </MenuRoot>
    </ToastProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Message actions" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Catch me up" }),
  );
  await waitFor(() => expect(open).toHaveBeenCalledOnce());
  const target = parseContextualCatchUpTarget(open.mock.calls[0]?.[0] ?? "");
  expect(target).toEqual({ thread: message.id, agent: "d".repeat(64) });
  expect(
    readLinkedChat(scope, contextualDraftKey(message.id, "d".repeat(64))),
  ).toEqual(source);
  expect(startChat).not.toHaveBeenCalled();
});

it("does not contribute an Ask item while no usable Bestie is saved", async () => {
  hookState.saved.agent = undefined;
  render(
    <ToastProvider>
      <MenuRoot>
        <MenuTrigger>Message actions</MenuTrigger>
        <MenuPopup>
          <AskBestieAction
            message={message}
            session={session}
            close={() => {}}
            canOpen={() => true}
            open={() => true}
          />
        </MenuPopup>
      </MenuRoot>
    </ToastProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Message actions" }));
  await screen.findByRole("menu");
  expect(screen.queryByRole("menuitem", { name: "Catch me up" })).toBeNull();
});

it("presents the linked source as an editable unsent draft in the side panel", async () => {
  const link = `buzz://message?channel=design&id=${message.id}`;
  writeView(scope, contextualDraftKey(message.id, "b".repeat(64)), {
    channelId: "design",
    link,
  });
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    scope,
    origin: "https://relay.test",
    viewer,
    session,
  };
  const relay = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    tryAgain() {},
    disconnect() {},
    clearCache: async () => {},
  } satisfies RelayData;
  const none: readonly never[] = [];
  const contributions = { snapshot: () => none, subscribe: () => () => {} };
  render(
    <ToastProvider>
      <ContextualAskPanel
        target={contextualAskTarget({
          source: message.id,
          agent: "b".repeat(64),
        })}
        close={() => {}}
        relay={relay}
        host={{} as never}
        extensions={{ tools: contributions, inline: contributions }}
      />
    </ToastProvider>,
  );
  expect(screen.getByLabelText("Pollen")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Close chat with Pollen" }),
  ).toBeNull();
  const editor = await screen.findByRole("textbox");
  expect(editor).toHaveTextContent(link);
  expect(startChat).not.toHaveBeenCalled();
});

it("keeps the linked source while first-send cleanup records its started chat", async () => {
  const link = `buzz://message?channel=design&id=${message.id}`;
  const key = contextualDraftKey(message.id, "b".repeat(64));
  writeView(scope, key, { channelId: "design", link });
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    scope,
    origin: "https://relay.test",
    viewer,
    session,
  };
  const relay = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    tryAgain() {},
    disconnect() {},
    clearCache: async () => {},
  } satisfies RelayData;
  const none: readonly never[] = [];
  const contributions = { snapshot: () => none, subscribe: () => () => {} };
  const panel = (
    <ToastProvider>
      <ContextualAskPanel
        target={contextualAskTarget({
          source: message.id,
          agent: "b".repeat(64),
        })}
        close={() => {}}
        relay={relay}
        host={{} as never}
        extensions={{ tools: contributions, inline: contributions }}
      />
    </ToastProvider>
  );
  const rendered = render(panel);
  expect(await screen.findByRole("textbox")).toHaveTextContent(link);

  act(() => {
    writeView(scope, key, null);
  });
  // An optimistic channel-list update rerenders the panel in this window.
  // The source consumption must not unmount SoloDraft before onStarted runs.
  rendered.rerender(panel);

  expect(screen.queryByText(/chat draft is unavailable/i)).toBeNull();
  expect(screen.getByRole("textbox")).toHaveTextContent(link);
});

it("shows a loading state instead of retiring a valid panel during agent discovery", () => {
  hookState.choices.selectable.splice(0);
  hookState.choices.complete = false;
  hookState.choices.pending = true;
  hookState.choices.archives.status = "loading";
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    scope,
    origin: "https://relay.test",
    viewer,
    session,
  };
  const relay = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    tryAgain() {},
    disconnect() {},
    clearCache: async () => {},
  } satisfies RelayData;
  const close = vi.fn();
  const none: readonly never[] = [];
  const contributions = { snapshot: () => none, subscribe: () => () => {} };
  render(
    <ToastProvider>
      <ContextualAskPanel
        target={contextualAskTarget({
          source: message.id,
          agent: "b".repeat(64),
        })}
        channelContext={{
          scope,
          channelId: "design",
          channelName: "Design",
          viewer,
          relayUrl: "https://relay.test",
        }}
        close={close}
        relay={relay}
        host={{} as never}
        extensions={{ tools: contributions, inline: contributions }}
      />
    </ToastProvider>,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Loading your Bestie");
  expect(close).not.toHaveBeenCalled();
});
