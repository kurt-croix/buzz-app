import { useEffect, useState } from "react";
import type {
  ConversationExtensions,
  MessageAction,
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
import { splitPartition } from "../../features/relay/partition";
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
import { readView, writeView } from "../../shared/view-state";
import { AgentPortrait } from "../agents/AgentCard";
import { ChannelBody } from "../channels/ChannelBody";
import { MenuIcon, MenuItem } from "../../shared/design-system/ui/Menu";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { XIcon } from "../../shared/design-system/icons";
import { useToastNotification } from "../../shared/design-system/ui/Toast";

const TARGET = "buzz://bestie/ask";
const agentKey = /^[0-9a-f]{64}$/;

type AskTarget = Readonly<{ source: string; agent: string }>;
type Bestie = Readonly<{
  pubkey: string;
  name: string;
  picture?: string | undefined;
}>;

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

const contextualDraftId = (source: string, agent: string) =>
  `${source}:bestie:${agent}`;
const contextualDraftKey = (source: string, agent: string) =>
  linkedDraftKey(contextualDraftId(source, agent));
const startedChatKey = (source: string, agent: string) =>
  `${contextualDraftKey(source, agent)}:started-chat`;

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

/** The shared menu owns dismissal and focus; the ordinary Solo action remains. */
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
      const link = messageCopyLink(message, session.scope);
      if (!link)
        throw new Error("This source is unavailable. Reopen it and try again.");
      const source: LinkedChat = { channelId: message.channelId, link };
      const target = contextualAskTarget({
        source: message.id,
        agent: activeBestie.pubkey,
      });
      if (!canOpen(target))
        throw new Error("Your Bestie chat couldn’t open. Try again.");
      const key = contextualDraftKey(message.id, activeBestie.pubkey);
      const started = readView<unknown>(
        session.scope,
        startedChatKey(message.id, activeBestie.pubkey),
        null,
      );
      if (typeof started !== "string" && !writeView(session.scope, key, source))
        throw new Error(
          "Your new chat draft couldn’t be saved. Nothing opened.",
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
      Ask {activeBestie.name}
    </MenuItem>
  );
}

function Close({ name, close }: { name: string; close(): void }) {
  return (
    <IconButton
      size="toolbar"
      aria-label={`Close chat with ${name}`}
      title="Close chat"
      onClick={close}
      icon={<XIcon size="1rem" aria-hidden="true" />}
    />
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
  const connection = useRelayConnection(relay);
  const { session } = connection;
  const scope = channelContext?.scope ?? "";
  const saved = useSavedAgentState(session, scope);
  const choices = useAgentChoices(session, true, true);
  const bestie = selectedBestie(saved, choices);
  const channels = useChannelList(session.channels);
  const notify = useToastNotification();
  const startedKey =
    ask && scope ? startedChatKey(ask.source, ask.agent) : undefined;
  const [startedState, setStartedState] = useState(() => ({
    key: startedKey,
    value: startedKey ? readView<unknown>(scope, startedKey, null) : null,
  }));
  // Panel hosts may reuse this component for a new target. Never show the
  // previous source's chat for even one render while React resets local state.
  const started =
    startedState.key === startedKey
      ? startedState.value
      : startedKey
        ? readView<unknown>(scope, startedKey, null)
        : null;
  const channelId = typeof started === "string" ? started : undefined;
  const channel = channelId
    ? channels.channels.find((item) => item.id === channelId)
    : undefined;
  const source =
    ask && scope
      ? readLinkedChat(scope, contextualDraftKey(ask.source, ask.agent))
      : undefined;
  const stale = !!(
    ask &&
    ((connection.scope && connection.scope !== scope) ||
      (saved.read && saved.agent !== ask.agent) ||
      (saved.read && saved.agent === ask.agent && choices.complete && !bestie))
  );
  useEffect(() => {
    if (stale) close();
  }, [stale, close]);

  if (!ask || !channelContext) return null;
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
  if (bestie.pubkey !== ask.agent) return null;

  const community = splitPartition(scope)?.communityOrigin;
  const icon = (
    <AgentPortrait
      agent={{ name: bestie.name, picture: bestie.picture }}
      community={community}
    />
  );
  const closeAction = <Close name={bestie.name} close={close} />;
  if (channelId && !channel)
    return (
      <SoloConversationView
        title={bestie.name}
        ariaLabel={`Chat with ${bestie.name}`}
        icon={icon}
        actions={closeAction}
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
            actions={closeAction}
            attachmentDropZone
          >
            <SoloColumn>
              <ChannelBody
                cached={!!channel.cached}
                viewer={session.viewer}
                marksRead
              />
              <ConversationComposer autoFocus />
            </SoloColumn>
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
        actions={closeAction}
      >
        <p role="alert" className="m-0 p-4 text-body-sm text-danger">
          This chat draft is unavailable. Start again from its source.
        </p>
      </SoloConversationView>
    );
  return (
    <SoloDraft
      linkedId={contextualDraftId(ask.source, ask.agent)}
      source={source}
      agent={bestie.pubkey}
      session={session}
      scope={scope}
      extensions={extensions}
      title={bestie.name}
      icon={icon}
      headerActions={closeAction}
      focusRequest={1}
      onStarted={(id) => {
        if (!startedKey || !writeView(scope, startedKey, id))
          notify(
            "The chat started, but its source link couldn’t be saved on this device.",
            "error",
          );
        setStartedState({ key: startedKey, value: id });
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
