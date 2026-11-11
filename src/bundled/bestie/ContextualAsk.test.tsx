// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import {
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
  ContextualAskPanel,
  contextualAskTarget,
  parseContextualAskTarget,
} from "./ContextualAsk";
import { writeView } from "../../shared/view-state";
import type { RelayData } from "../../features/relay/service";

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

it("offers the exact saved Bestie and opens a deterministic unsent linked draft", async () => {
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
  const item = await screen.findByRole("menuitem", { name: "Ask Pollen" });
  expect(item).toHaveTextContent("Ask Pollen");
  fireEvent.click(item);
  // Menu-hosted contributions retire as selection closes the menu. Opening
  // must finish in this click instead of depending on an async continuation.
  expect(open).toHaveBeenCalledOnce();
  const target = parseContextualAskTarget(open.mock.calls[0]?.[0] ?? "");
  expect(target?.agent).toBe("b".repeat(64));
  expect(target?.source).toBe(message.id);
  expect(
    readLinkedChat(
      scope,
      contextualDraftKey(target?.source ?? "", "b".repeat(64)),
    ),
  ).toEqual({
    channelId: "design",
    link: `buzz://message?channel=design&id=${message.id}`,
  });
  expect(startChat).not.toHaveBeenCalled();
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
  await user.click(await screen.findByRole("menuitem", { name: "Ask Honey" }));
  await waitFor(() => expect(open).toHaveBeenCalledOnce());
  const target = parseContextualAskTarget(open.mock.calls[0]?.[0] ?? "");
  expect(target).toEqual({ source: message.id, agent: "d".repeat(64) });
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
  expect(screen.queryByRole("menuitem", { name: /Ask / })).toBeNull();
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
        channelContext={{
          scope,
          channelId: "design",
          channelName: "Design",
          viewer,
          relayUrl: "https://relay.test",
        }}
        close={() => {}}
        relay={relay}
        host={{} as never}
        extensions={{ tools: contributions, inline: contributions }}
      />
    </ToastProvider>,
  );
  expect(screen.getByLabelText("Pollen")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Close chat with Pollen" }),
  ).toBeInTheDocument();
  const editor = await screen.findByRole("textbox");
  expect(editor).toHaveTextContent(link);
  expect(startChat).not.toHaveBeenCalled();
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
