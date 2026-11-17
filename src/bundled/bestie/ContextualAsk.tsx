import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  ConversationExtensions,
  MessageAction,
  MessageRenderer,
} from "../../features/conversation/contracts";
import type { ConversationHostServices } from "../../features/conversation/ConversationHost";
import {
  ConversationChannel,
  ConversationComposer,
} from "../../features/conversation/Conversation";
import { ConversationPresentation } from "../../features/conversation/ConversationPresentation";
import { messageCopyLink } from "../../features/messages/message-copy";
import type { PanelProps } from "../../features/panels/service";
import { useAgentChoices } from "../../features/agents/use-choices";
import { useChannelList, useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelMessage } from "../../features/relay/contracts";
import type { UnreadSnapshot } from "../../features/relay/unread";
import { relayPartition, splitPartition } from "../../features/relay/partition";
import { useSavedAgentState } from "../../features/solo/default-agent";
import {
  linkedDraftKey,
  readLinkedChat,
  type LinkedChat,
} from "../../features/solo/linked-chat";
import { SoloDraft } from "../../features/solo/SoloDraft";
import {
  SoloColumn,
  SoloConversationView,
} from "../../features/solo/SoloPresentation";
import {
  readView,
  subscribeView,
  viewRevision,
  writeView,
} from "../../shared/view-state";
import { AgentPortrait } from "../agents/AgentCard";
import { ChannelBody } from "../channels/ChannelBody";
import { MenuIcon, MenuItem } from "../../shared/design-system/ui/Menu";
import { Button } from "../../shared/design-system/ui/Button";
import { WorkspaceSettings } from "../../features/solo/WorkspaceSettings";
import { canEditLifetime } from "../../features/solo/Lifetime";
import { channelDurationLabel } from "../channels/ChannelDurationField";
import { DEFAULT_TEMPORARY_CHANNEL_TTL_SECONDS } from "../../features/relay/channel-writes";
import type { MessageComposerProps } from "../../features/messages/MessageComposer";
import { useBackgroundSendPending } from "../../features/messages/background-upload";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import type { Panels } from "../../features/panels/service";
import { usePanelTabTitle } from "../../features/panels/PanelWorkspace";
import type { SidebarRowMenuProps } from "../../features/channel-navigation/sidebar-rows-service";
import {
  followupDraft,
  mentionDraft,
} from "../../features/messages/mention-draft";
import { canStartLinkedChat } from "../channels/StartLinkedChat";
import { startingChatTitle } from "../../features/solo/chat-title";
import { canonicalDetailsName } from "../../features/relay/channel-details-protocol";
import { MessageMarkdown } from "../../features/messages/MessageMarkdown";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import {
  CATCH_UP_WORKSPACE_ID,
  CATCH_UP_WORKSPACE_NAME,
  isCatchUpWorkspace,
} from "./catch-up-workspace";

const TARGET = "buzz://bestie/ask";
const CATCH_UP_TARGET = "buzz://bestie/catch-up";
const RECENT_CATCH_UP_SECONDS = 2 * 86_400;
const PERSONAL_CATCH_UP =
  "Lead with the few things most relevant to me based on what you know about my priorities, work, and people, and briefly say why. If you lack that context, prioritize decisions, direct asks, risks, blockers, and meaningful changes. Summarize everything else at a very high level. Link the important sources, and skip the play-by-play unless I ask.";
const PERSONAL_CATCH_UP_ENDING = `. ${PERSONAL_CATCH_UP}`;
const PROGRESS_UPDATE =
  "If you send a progress update before the result, use only “Taking a look now. I’ll let you know what I find.”";
const PROGRESS_UPDATE_ENDING = `. ${PROGRESS_UPDATE}`;
const agentKey = /^[0-9a-f]{64}$/;

type AskTarget = Readonly<{ source: string; agent: string }>;
type ChannelCatchUpBase = {
  channel: string;
  latest: string;
  agent: string;
};
type ChannelCatchUpTarget =
  | Readonly<ChannelCatchUpBase & { oldest: string }>
  | Readonly<ChannelCatchUpBase & { since: number }>;
type CatchUpTarget =
  | ChannelCatchUpTarget
  | Readonly<{ thread: string; agent: string }>;
type Bestie = Readonly<{
  pubkey: string;
  name: string;
  picture?: string | undefined;
}>;

const messageTargetPattern = String.raw`buzz:\/\/message\?channel=[^&\s()]+&id=[0-9a-f]{64}`;
const threadRequest = new RegExp(
  String.raw`^Read the entire \[thread\]\(${messageTargetPattern}\), including its root and every reply, then catch me up$`,
);
const channelRequest =
  /^Catch me up on \[#((?:\\.|[^\]])+)\]\((buzz:\/\/channel\/[^\s()]+)\), (.+)$/;
const singleUnreadRange = new RegExp(
  String.raw`^using \[the unread message\]\(${messageTargetPattern}\)$`,
);
const unreadRange = new RegExp(
  String.raw`^from \[the first unread message\]\(${messageTargetPattern}\) through \[the latest message at this moment\]\(${messageTargetPattern}\)$`,
);
const recentRange = new RegExp(
  String.raw`^covering the two days since \`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\` through \[the latest message at this moment\]\(${messageTargetPattern}\)$`,
);

const channelAccessResponse = (label: string, channel: string) =>
  `I don’t have access to [#${label}](${channel}). Add me to the channel, or paste the messages here for me to review.`;

const channelAccessFallback = (
  label: string,
  channel: string,
  knownMissing = false,
) =>
  knownMissing
    ? `The current private channel roster does not include you. Do not inspect the source or send a progress update; reply with only “${channelAccessResponse(label, channel)}”`
    : `First verify that you can read the channel and requested messages. Do not send a progress update before this check. If you cannot read them because you do not have access, reply with only “${channelAccessResponse(label, channel)}”`;

function addressedRequest(content: string, marker: string) {
  const start = content.lastIndexOf(marker);
  if (start < 2 || content[start - 1] !== " ") return;
  const address = content.slice(0, start - 1);
  if (!address.startsWith("@") || /[\r\n]/.test(address)) return;
  return content.slice(start);
}

function personalizedRequest(request: string) {
  if (!request.endsWith(PERSONAL_CATCH_UP_ENDING)) return;
  const withoutPersonalization = request.slice(
    0,
    -PERSONAL_CATCH_UP_ENDING.length,
  );
  return withoutPersonalization.endsWith(PROGRESS_UPDATE_ENDING)
    ? withoutPersonalization.slice(0, -PROGRESS_UPDATE_ENDING.length)
    : withoutPersonalization;
}

/** Recognizes only Bestie's generated requests; the sent prose remains canonical. */
export function catchUpRequestSummary(content: string) {
  const threadMarker = "Read the entire [thread](";
  const threadRequestWithInstructions = addressedRequest(content, threadMarker);
  const thread = threadRequestWithInstructions
    ? personalizedRequest(threadRequestWithInstructions)
    : undefined;
  if (thread && threadRequest.test(thread)) return "Catch me up on this thread";

  const channelMarker = "Catch me up on [#";
  const addressedChannel = addressedRequest(content, channelMarker);
  if (!addressedChannel) return;
  const personalizedChannel = personalizedRequest(addressedChannel);
  const channel = personalizedChannel ?? addressedChannel;
  const match = channel.match(channelRequest);
  const label = match?.[1];
  const link = match?.[2];
  const request = match?.[3];
  if (!label || !link || !request) return;
  const fallback = `. ${channelAccessFallback(
    label,
    link,
    personalizedChannel === undefined,
  )}`;
  if (personalizedChannel === undefined && !request.endsWith(fallback)) return;
  const range = request.endsWith(fallback)
    ? request.slice(0, -fallback.length)
    : request;
  const rangeLabel = singleUnreadRange.test(range)
    ? "unread message"
    : unreadRange.test(range)
      ? "unread → now"
      : recentRange.test(range)
        ? "last 2 days"
        : undefined;
  if (!rangeLabel) return;
  return `Catch me up on #${label.replace(/\\([\\`[\]*_~<>&|])/g, "$1")} · ${rangeLabel}`;
}

/** Bestie keeps its generated request available without making it the chat's focus. */
export function CatchUpRequestMessage({
  message,
  canOpen,
  open,
}: React.ComponentProps<MessageRenderer["component"]>) {
  const summary = catchUpRequestSummary(message.content);
  const [expanded, setExpanded] = useState<string[]>([]);
  if (!summary) return null;
  const shown = expanded.includes("request");
  return (
    <Accordion
      variant="activity"
      value={expanded}
      onValueChange={setExpanded}
      items={[
        {
          value: "request",
          title: (
            <span className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <span>{summary}</span>
              <span className="text-label-sm">
                {shown ? "Hide request" : "Show request"}
              </span>
            </span>
          ),
          content: (
            <MessageMarkdown
              row={message}
              media={() => undefined}
              onOpenLink={open}
              canOpenLink={canOpen}
            />
          ),
        },
      ]}
    />
  );
}

const isUnreadCatchUp = (
  target: ChannelCatchUpTarget,
): target is Readonly<ChannelCatchUpBase & { oldest: string }> =>
  "oldest" in target;

export function contextualAskTarget({ source, agent }: AskTarget) {
  const target = new URL(TARGET);
  target.searchParams.set("source", source);
  target.searchParams.set("agent", agent);
  return target.toString();
}

export function parseContextualAskTarget(
  target: string,
): AskTarget | undefined {
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return;
  }
  if (
    `${parsed.protocol}//${parsed.host}${parsed.pathname}` !== TARGET ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  )
    return;
  const source = parsed.searchParams.get("source") ?? "";
  const agent = parsed.searchParams.get("agent") ?? "";
  if (
    parsed.searchParams.size !== 2 ||
    !agentKey.test(source) ||
    !agentKey.test(agent)
  )
    return;
  return { source, agent };
}

export function contextualCatchUpTarget(target: CatchUpTarget) {
  const result = new URL(CATCH_UP_TARGET);
  if ("thread" in target) result.searchParams.set("thread", target.thread);
  else {
    result.searchParams.set("channel", target.channel);
    if (isUnreadCatchUp(target))
      result.searchParams.set("oldest", target.oldest);
    else result.searchParams.set("since", String(target.since));
    result.searchParams.set("latest", target.latest);
  }
  result.searchParams.set("agent", target.agent);
  return result.toString();
}

export function parseContextualCatchUpTarget(
  target: string,
): CatchUpTarget | undefined {
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return;
  }
  if (
    `${parsed.protocol}//${parsed.host}${parsed.pathname}` !==
      CATCH_UP_TARGET ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  )
    return;
  const thread = parsed.searchParams.get("thread");
  const agent = parsed.searchParams.get("agent") ?? "";
  if (thread !== null)
    return parsed.searchParams.size === 2 &&
      agentKey.test(thread) &&
      agentKey.test(agent)
      ? { thread, agent }
      : undefined;
  const channel = parsed.searchParams.get("channel") ?? "";
  const oldest = parsed.searchParams.get("oldest");
  const sinceValue = parsed.searchParams.get("since");
  const latest = parsed.searchParams.get("latest") ?? "";
  const since = sinceValue === null ? undefined : Number(sinceValue);
  const unreadRange =
    sinceValue === null && oldest !== null && agentKey.test(oldest);
  const recentRange =
    oldest === null &&
    sinceValue !== null &&
    /^[1-9]\d{0,15}$/.test(sinceValue) &&
    Number.isSafeInteger(since);
  if (
    parsed.searchParams.size !== 4 ||
    !channel ||
    channel.length > 512 ||
    /[\p{Cc}\p{Cf}]/u.test(channel) ||
    unreadRange === recentRange ||
    !agentKey.test(latest) ||
    !agentKey.test(agent)
  )
    return;
  if (unreadRange && oldest !== null) return { channel, oldest, latest, agent };
  if (recentRange && since !== undefined)
    return { channel, since, latest, agent };
}

const catchUpSourceId = (target: CatchUpTarget) =>
  "thread" in target
    ? target.thread
    : isUnreadCatchUp(target)
      ? `catch-up:${target.channel}:${target.oldest}:${target.latest}`
      : `catch-up:${target.channel}:recent:${target.latest}`;

const messageLink = (channel: string, id: string) =>
  `buzz://message?${new URLSearchParams({ channel, id })}`;

function catchUpDraft(
  target: ChannelCatchUpTarget,
  channelName: string,
  bestie: Bestie,
  knownMissing = false,
) {
  const channel = `buzz://channel/${encodeURIComponent(target.channel)}`;
  const latest = messageLink(target.channel, target.latest);
  const label = channelName.replace(/[\\`[\]*_~<>&|]/g, "\\$&");
  const draft = followupDraft([{ pubkey: bestie.pubkey, name: bestie.name }]);
  const range = isUnreadCatchUp(target)
    ? target.oldest === target.latest
      ? `using [the unread message](${messageLink(target.channel, target.oldest)})`
      : `from [the first unread message](${messageLink(target.channel, target.oldest)}) through [the latest message at this moment](${latest})`
    : `covering the two days since \`${new Date(target.since * 1000).toISOString()}\` through [the latest message at this moment](${latest})`;
  const request = `Catch me up on [#${label}](${channel}), ${range}`;
  return mentionDraft({
    ...draft,
    text: knownMissing
      ? `${draft.text}${request}. ${channelAccessFallback(label, channel, true)}`
      : `${draft.text}${request}. ${channelAccessFallback(label, channel)}. ${PROGRESS_UPDATE}. ${PERSONAL_CATCH_UP}`,
  });
}

function threadCatchUpDraft(source: LinkedChat, bestie: Bestie) {
  const draft = followupDraft([{ pubkey: bestie.pubkey, name: bestie.name }]);
  return mentionDraft({
    ...draft,
    text: `${draft.text}Read the entire [thread](${source.link}), including its root and every reply, then catch me up. ${PROGRESS_UPDATE}. ${PERSONAL_CATCH_UP}`,
  });
}

function threadCatchUpTitle(message: ChannelMessage, session: RelaySession) {
  if (!message.threadRootId)
    return catchUpTitle(startingChatTitle(message.content));
  try {
    const view = session.thread(message.channelId, message.threadRootId);
    try {
      return catchUpTitle(
        startingChatTitle(view.snapshot().root?.content ?? "Thread"),
      );
    } finally {
      view.dispose();
    }
  } catch {
    return catchUpTitle("Thread");
  }
}

const catchUpDate = (at: number) =>
  new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(at);

function catchUpTitle(subject: string, at = Date.now()) {
  const date = catchUpDate(at);
  const suffix = ` · ${date}`;
  const topic = canonicalDetailsName(subject) || "Thread";
  return canonicalDetailsName(
    [...topic].slice(0, Math.max(1, 64 - [...suffix].length)).join("") + suffix,
  );
}

const contextualDraftId = (source: string, agent: string) =>
  `${source}:bestie:${agent}`;
const contextualDraftKey = (source: string, agent: string) =>
  linkedDraftKey(contextualDraftId(source, agent));
const startedChatKey = (source: string, agent: string) =>
  `${contextualDraftKey(source, agent)}:started-chat`;

function seedContextualRequest(
  scope: string,
  sourceId: string,
  bestie: Bestie,
  source: LinkedChat,
  draft: ReturnType<typeof mentionDraft>,
  requestTarget: string,
  title: string,
) {
  const key = contextualDraftKey(sourceId, bestie.pubkey);
  // Keep the source available when an existing catch-up is reopened. Solo's
  // first-send owner consumes its draft source after creating the chat.
  if (!writeView(scope, `${key}:source`, source)) return false;
  if (
    writeView(scope, key, source) &&
    writeView(scope, `${key}:new-draft`, draft) &&
    writeView(scope, `${key}:settings`, {
      name: title,
      ttlSeconds: DEFAULT_TEMPORARY_CHANNEL_TTL_SECONDS,
      lifetimeChosen: true,
    }) &&
    writeView(scope, `${key}:submit-request`, requestTarget)
  )
    return true;
  writeView(scope, key, null);
  writeView(scope, `${key}:new-draft`, null);
  writeView(scope, `${key}:settings`, null);
  writeView(scope, `${key}:submit-request`, null);
  return false;
}

export async function fileCatchUpChat(
  session: RelaySession,
  channelId: string,
) {
  await session.soloPreferences.ensure();
  const snapshot = session.soloPreferences.snapshot();
  if (snapshot.status !== "ready" || !snapshot.data)
    throw new Error(snapshot.error ?? "Solo workspaces are unavailable.");
  const workspace = snapshot.data.sections.find(isCatchUpWorkspace);
  if (workspace && snapshot.data.assignments[channelId] === workspace.id)
    return;
  if (workspace) {
    await session.soloPreferences.assign(channelId, workspace.id);
    return;
  }
  await session.soloPreferences.createAndAssign(channelId, {
    id: CATCH_UP_WORKSPACE_ID,
    name: CATCH_UP_WORKSPACE_NAME,
  });
}

function catchUpRange(
  unread: UnreadSnapshot,
  now = Math.floor(Date.now() / 1000),
):
  | Readonly<{ oldest: string; latest: string }>
  | Readonly<{ since: number; latest: string }>
  | undefined {
  const shown = unread.row ?? unread;
  if (shown.observedCount === null) return;
  if (shown.observedCount > 0)
    return unread.oldestUnreadId && unread.latestMessage?.id
      ? { oldest: unread.oldestUnreadId, latest: unread.latestMessage.id }
      : undefined;
  if (
    shown.observedCount !== 0 ||
    !unread.latestMessage?.id ||
    unread.latestMessage.createdAt < now - RECENT_CATCH_UP_SECONDS
  )
    return;
  return {
    since: now - RECENT_CATCH_UP_SECONDS,
    latest: unread.latestMessage.id,
  };
}

function selectedBestie(
  saved: ReturnType<typeof useSavedAgentState>,
  choices: ReturnType<typeof useAgentChoices>,
): Bestie | undefined {
  const agent = choices.selectable.find((item) => item.pubkey === saved.agent);
  return agent
    ? {
        pubkey: agent.pubkey,
        name: agent.managedName ?? agent.name,
        ...(agent.avatar ? { picture: agent.avatar } : {}),
      }
    : undefined;
}

/** A thread is a known request, so its menu action sends immediately. */
export function AskBestieAction({
  message,
  session,
  canOpen,
  open,
}: React.ComponentProps<MessageAction["component"]>) {
  const saved = useSavedAgentState(session, session.scope);
  const choices = useAgentChoices(session, true, true);
  const bestie = selectedBestie(saved, choices);
  const notify = useToastNotification();
  const [busy, setBusy] = useState(false);
  const community = splitPartition(session.scope)?.communityOrigin;
  if (!saved.read || saved.error || !bestie) return null;
  const activeBestie = bestie;

  function start() {
    if (busy) return;
    setBusy(true);
    try {
      const sourceId = message.threadRootId ?? message.id;
      const link = message.threadRootId
        ? messageLink(message.channelId, sourceId)
        : messageCopyLink(message, session.scope);
      if (!link)
        throw new Error("This source is unavailable. Reopen it and try again.");
      const source: LinkedChat = { channelId: message.channelId, link };
      const target = contextualCatchUpTarget({
        thread: sourceId,
        agent: activeBestie.pubkey,
      });
      if (!canOpen(target))
        throw new Error("Your Bestie chat couldn’t open. Try again.");
      if (
        !seedContextualRequest(
          session.scope,
          sourceId,
          activeBestie,
          source,
          threadCatchUpDraft(source, activeBestie),
          target,
          threadCatchUpTitle(message, session),
        )
      )
        throw new Error(
          "Your catch-up request couldn’t be saved. Nothing opened.",
        );
      if (!open(target))
        throw new Error("Your Bestie chat couldn’t open. Try again.");
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
      setBusy(false);
    }
  }

  return (
    <MenuItem disabled={busy} onClick={start}>
      <MenuIcon>
        <AgentPortrait
          agent={{ name: activeBestie.name, picture: activeBestie.picture }}
          community={community}
        />
      </MenuIcon>
      Catch me up
    </MenuItem>
  );
}

/** One known channel request sends immediately; the row menu and panel host own placement. */
export function CatchUpBestieAction({
  row,
  session,
  target,
  available,
  close,
  relay,
  panels,
}: SidebarRowMenuProps & { relay: RelayData; panels: Panels }) {
  const unreadTarget = useMemo(
    () => ({ kind: "channel" as const, channelId: row.channel.id }),
    [row.channel.id],
  );
  const unread = useSyncExternalStore(
    useCallback(
      (listener) => session.unread.subscribe(unreadTarget, listener),
      [session, unreadTarget],
    ),
    useCallback(
      () => session.unread.snapshot(unreadTarget),
      [session, unreadTarget],
    ),
  );
  const saved = useSavedAgentState(session, session.scope);
  const choices = useAgentChoices(session, true, true);
  const bestie = selectedBestie(saved, choices);
  const notify = useToastNotification();
  const [busy, setBusy] = useState(false);
  const hostChannel =
    target.kind === "conversation" &&
    relayPartition(target.scope.communityOrigin, target.scope.viewer) ===
      session.scope
      ? target.channelId
      : undefined;
  const range = catchUpRange(unread);
  if (
    row.kind !== "team" ||
    row.channel.cached ||
    !hostChannel ||
    !range ||
    !saved.read ||
    saved.error ||
    !bestie ||
    !canStartLinkedChat(session, row.channel.id)
  )
    return null;
  const activeBestie = bestie;
  const activeHostChannel = hostChannel;

  function start() {
    if (busy || !available()) return;
    setBusy(true);
    try {
      const connection = relay.snapshot();
      if (
        connection.status !== "ready" ||
        connection.session !== session ||
        connection.scope !== session.scope
      )
        throw new Error("Reconnect before asking your Bestie to catch you up.");
      const current = session.unread.snapshot(unreadTarget);
      const currentRange = catchUpRange(current);
      if (!currentRange)
        throw new Error(
          "This channel no longer has unread or recent messages to catch up on.",
        );
      const catchUp: ChannelCatchUpTarget = {
        channel: row.channel.id,
        ...currentRange,
        agent: activeBestie.pubkey,
      };
      const panelTarget = contextualCatchUpTarget(catchUp);
      if (!panels.resolve(panelTarget))
        throw new Error("Your Bestie chat couldn’t open. Try again.");
      const sourceId = catchUpSourceId(catchUp);
      const source: LinkedChat = {
        channelId: row.channel.id,
        link: `buzz://channel/${encodeURIComponent(row.channel.id)}`,
      };
      const currentChannel =
        session.channels
          .list()
          .channels.find(({ id }) => id === row.channel.id) ?? row.channel;
      const knownMissing =
        currentChannel.private === true &&
        currentChannel.members !== undefined &&
        !currentChannel.members.includes(activeBestie.pubkey);
      if (
        !seedContextualRequest(
          session.scope,
          sourceId,
          activeBestie,
          source,
          catchUpDraft(
            catchUp,
            currentChannel.name,
            activeBestie,
            knownMissing,
          ),
          panelTarget,
          catchUpTitle(`#${currentChannel.name}`),
        )
      )
        throw new Error(
          "Your catch-up request couldn’t be saved. Nothing opened.",
        );
      if (
        !panels.requestOpen({
          target: panelTarget,
          channelId: activeHostChannel,
        })
      )
        throw new Error("Your Bestie chat couldn’t open here. Try again.");
      close();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
      setBusy(false);
    }
  }

  const community = splitPartition(session.scope)?.communityOrigin;
  return (
    <MenuItem disabled={busy} onClick={start}>
      <MenuIcon>
        <AgentPortrait
          agent={{ name: activeBestie.name, picture: activeBestie.picture }}
          community={community}
        />
      </MenuIcon>
      Catch me up
    </MenuItem>
  );
}

/** The current channel side-column host supplies the split, focus fence and
 * close behavior. This panel supplies only the ordinary linked Solo content. */
export function ContextualAskPanel({
  target,
  channelContext,
  close,
  relay,
  host,
  extensions,
}: PanelProps & {
  relay: RelayData;
  host: ConversationHostServices;
  extensions: ConversationExtensions;
}) {
  const ask = parseContextualAskTarget(target);
  const catchUp = parseContextualCatchUpTarget(target);
  const request = ask ?? catchUp;
  const sourceId =
    ask?.source ?? (catchUp ? catchUpSourceId(catchUp) : undefined);
  const agent = request?.agent;
  const connection = useRelayConnection(relay);
  const { session } = connection;
  // Link-opened panel tabs do not carry channelContext; the live connection
  // remains the authority for the account/community partition.
  const scope = connection.scope ?? channelContext?.scope ?? "";
  const saved = useSavedAgentState(session, scope);
  const choices = useAgentChoices(session, true, true);
  const bestie = selectedBestie(saved, choices);
  const channels = useChannelList(session.channels);
  const notify = useToastNotification();
  const draftKey =
    sourceId && agent && scope
      ? contextualDraftKey(sourceId, agent)
      : undefined;
  const seededSubmitRequest = draftKey
    ? readView<unknown>(scope, `${draftKey}:submit-request`, null)
    : null;
  const startedKey =
    sourceId && agent && scope ? startedChatKey(sourceId, agent) : undefined;
  const [startedState, setStartedState] = useState(() => ({
    key: startedKey,
    value: startedKey ? readView<unknown>(scope, startedKey, null) : null,
  }));
  const [updateRequest, setUpdateRequest] = useState<{
    target: string;
    request: MessageComposerProps["submitRequest"];
  }>();
  const [settingsOpen, setSettingsOpen] = useState<string>();
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  // Panel hosts may reuse this component for a new target. Never show the
  // previous source's chat for even one render while React resets local state.
  const started =
    startedState.key === startedKey
      ? startedState.value
      : startedKey
        ? readView<unknown>(scope, startedKey, null)
        : null;
  const channelId = typeof started === "string" ? started : undefined;
  const updating = useBackgroundSendPending(
    session,
    `${scope}:draft:${channelId ?? ""}`,
  );
  const channel = channelId
    ? channels.channels.find((item) => item.id === channelId)
    : undefined;
  const staleStartedChat = !!(
    channelId &&
    channels.status === "ready" &&
    (!channel || channel.archived)
  );
  const seededSettings = draftKey
    ? readView<unknown>(scope, `${draftKey}:settings`, null)
    : null;
  const seededTitle =
    seededSettings &&
    typeof seededSettings === "object" &&
    "name" in seededSettings &&
    typeof seededSettings.name === "string"
      ? canonicalDetailsName(seededSettings.name)
      : "";
  const community = splitPartition(scope)?.communityOrigin;
  const bestieName = bestie?.name;
  const bestiePicture = bestie?.picture;
  const icon = useMemo(
    () =>
      bestieName ? (
        <AgentPortrait
          agent={{ name: bestieName, picture: bestiePicture }}
          community={community}
        />
      ) : undefined,
    [bestieName, bestiePicture, community],
  );
  usePanelTabTitle(channel?.name || seededTitle || "Bestie chat", icon);
  useEffect(() => {
    if (!staleStartedChat || !startedKey || !channelId) return;
    const savedChat = readView<unknown>(scope, startedKey, null);
    if (savedChat !== channelId) {
      setStartedState({ key: startedKey, value: savedChat });
      return;
    }
    if (!writeView(scope, startedKey, null))
      notify(
        "The old catch-up is unavailable, but its replacement could not be saved on this device.",
        "error",
      );
    setStartedState({ key: startedKey, value: null });
  }, [staleStartedChat, startedKey, channelId, scope, notify]);
  // Starting a linked Solo consumes its saved source before its final local
  // cleanup calls onStarted. Keep this panel visit's source through that gap:
  // the optimistic channel-list update may otherwise rerender and unmount the
  // draft before it can record which chat replaced it.
  useSyncExternalStore(
    useCallback(
      (listener) =>
        draftKey
          ? subscribeView(scope, (changedKey) => {
              if (
                changedKey === undefined ||
                changedKey === draftKey ||
                changedKey === `${draftKey}:source`
              )
                listener();
            })
          : () => {},
      [scope, draftKey],
    ),
    () =>
      draftKey
        ? JSON.stringify([
            viewRevision(scope, draftKey),
            viewRevision(scope, `${draftKey}:source`),
          ])
        : undefined,
  );
  const savedSource = draftKey
    ? (readLinkedChat(scope, draftKey) ??
      readLinkedChat(scope, `${draftKey}:source`))
    : undefined;
  const sourceState = useRef<{
    key: string | undefined;
    value: LinkedChat | undefined;
  }>(undefined);
  if (!sourceState.current || sourceState.current.key !== draftKey)
    sourceState.current = { key: draftKey, value: savedSource };
  else if (savedSource) sourceState.current.value = savedSource;
  const source = sourceState.current.value;
  const stale = !!(
    request &&
    ((connection.scope &&
      channelContext?.scope &&
      connection.scope !== channelContext.scope) ||
      (saved.read && saved.agent !== agent) ||
      (saved.read && saved.agent === agent && choices.complete && !bestie))
  );
  useEffect(() => {
    if (stale) close();
  }, [stale, close]);

  if (!request || !sourceId || !agent) return null;
  if (stale || connection.status !== "ready" || connection.scope !== scope)
    return <p role="status">Reconnect to continue this private chat.</p>;
  if (!saved.read) return <p role="status">Loading your Bestie…</p>;
  if (saved.error) return <p role="alert">{saved.error}</p>;
  if (!bestie) {
    const pending =
      choices.pending ||
      choices.archives.status === "idle" ||
      choices.archives.status === "loading";
    if (pending && !choices.error)
      return <p role="status">Loading your Bestie…</p>;
    if (choices.error || !choices.complete)
      return (
        <p role="alert">
          {choices.error ?? "Your agents are unavailable. Try again later."}
        </p>
      );
    return null;
  }
  if (bestie.pubkey !== agent) return null;

  // The same source/date identity names the retained panel tab and the
  // ordinary Solo chat; the Bestie portrait remains its conversation identity.
  if (staleStartedChat)
    return (
      <SoloConversationView
        title={bestie.name}
        ariaLabel={`Chat with ${bestie.name}`}
        icon={icon}
        embedded
      >
        <p role="status" className="m-0 p-4 text-body-sm text-subtle">
          Starting a new catch-up…
        </p>
      </SoloConversationView>
    );
  if (channelId && !channel)
    return (
      <SoloConversationView
        title={bestie.name}
        ariaLabel={`Chat with ${bestie.name}`}
        icon={icon}
        embedded
      >
        <p role="status" className="m-0 p-4 text-body-sm text-subtle">
          Opening your chat…
        </p>
      </SoloConversationView>
    );
  if (channel)
    return (
      <ConversationPresentation value>
        <ConversationChannel
          session={session}
          scope={scope}
          channel={channel}
          extensions={extensions}
          host={host}
          active
        >
          <SoloConversationView
            title={bestie.name}
            ariaLabel={`Chat with ${bestie.name}`}
            icon={icon}
            embedded
            attachmentDropZone
          >
            <SoloColumn>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <p className="m-0 flex-1 text-caption text-subtle">
                  With {bestie.name} ·{" "}
                  {channel.ttlSeconds
                    ? `Archives after ${channelDurationLabel(channel.ttlSeconds)} of inactivity`
                    : "Ongoing"}
                </p>
                {catchUp && "thread" in catchUp && source && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={
                      updateRequest?.target === `${scope}:${target}` ||
                      updating ||
                      !!channel.archived ||
                      !!channel.readOnly ||
                      !!channel.cached
                    }
                    onClick={() => {
                      setUpdateRequest({
                        target: `${scope}:${target}`,
                        request: {
                          id: crypto.randomUUID(),
                          draft: threadCatchUpDraft(source, bestie),
                          onSubmitted: () => setUpdateRequest(undefined),
                          onBlocked: () => {
                            setUpdateRequest(undefined);
                            notify(
                              "Send or clear your draft and finish any edit or recording before updating the catch-up.",
                              "info",
                            );
                          },
                        },
                      });
                    }}
                  >
                    Update catch-up
                  </Button>
                )}
                {canEditLifetime(session, channel) && (
                  <Button
                    ref={settingsTrigger}
                    size="sm"
                    variant="ghost"
                    onClick={() => setSettingsOpen(`${scope}:${target}`)}
                  >
                    Chat settings
                  </Button>
                )}
              </div>
              <ChannelBody
                cached={!!channel.cached}
                viewer={session.viewer}
                marksRead
              />
              <ConversationComposer
                autoFocus
                submitRequest={
                  updateRequest?.target === `${scope}:${target}`
                    ? updateRequest.request
                    : undefined
                }
                onSend={() => setUpdateRequest(undefined)}
              />
            </SoloColumn>
            {settingsOpen === `${scope}:${target}` && (
              <WorkspaceSettings
                key={channel.id}
                session={session}
                scope={scope}
                target={{ kind: "chat", id: channel.id, name: channel.name }}
                finalFocus={settingsTrigger}
                close={() => setSettingsOpen(undefined)}
              />
            )}
          </SoloConversationView>
        </ConversationChannel>
      </ConversationPresentation>
    );
  if (!source)
    return (
      <SoloConversationView
        title={bestie.name}
        ariaLabel={`Chat with ${bestie.name}`}
        icon={icon}
        embedded
      >
        <p role="alert" className="m-0 p-4 text-body-sm text-danger">
          This chat draft is unavailable. Start again from its source.
        </p>
      </SoloConversationView>
    );
  return (
    <SoloDraft
      linkedId={contextualDraftId(sourceId, agent)}
      source={source}
      agent={bestie.pubkey}
      session={session}
      scope={scope}
      extensions={extensions}
      title={bestie.name}
      icon={icon}
      embedded
      focusRequest={1}
      submitRequest={
        typeof seededSubmitRequest === "string" &&
        seededSubmitRequest === target
          ? target
          : undefined
      }
      onStarted={(id) => {
        if (draftKey) writeView(scope, `${draftKey}:submit-request`, null);
        if (!startedKey || !writeView(scope, startedKey, id))
          notify(
            "The chat started, but its source link couldn’t be saved on this device.",
            "error",
          );
        setStartedState({ key: startedKey, value: id });
        if (catchUp)
          void fileCatchUpChat(session, id).catch((error: unknown) => {
            notify(
              `The chat started, but it couldn’t be filed in Catch me up. ${
                error instanceof Error ? error.message : String(error)
              }`,
              "error",
            );
          });
      }}
      onFailed={(id, message, retry) => {
        if (startedKey && readView<unknown>(scope, startedKey, null) === id)
          writeView(scope, startedKey, null);
        setStartedState((current) =>
          current.key === startedKey
            ? { key: startedKey, value: null }
            : current,
        );
        notify(
          message,
          "error",
          retry
            ? {
                label: "Retry restoring message",
                onClick: () => void retry(),
                timeout: Infinity,
              }
            : undefined,
        );
      }}
    />
  );
}
