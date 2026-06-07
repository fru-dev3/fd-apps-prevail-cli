// =============================================================================
// ChannelAdapter — the generalized inbound/outbound contract for any messaging
// channel (Telegram today; WhatsApp/Signal/etc. tomorrow).
//
// TRACK E8 (additive, no behavior change). The Gateway owns N adapters and
// routes their normalized inbound envelopes to a domain deterministically via
// manifest.routing.keywords. Adapters are dumb pipes: they translate a
// channel's wire format into an InboundMessage and hand it to a handler, and
// they know how to send(text) back. They contain NO routing or model logic —
// that lives in gateway.ts so the model never picks the channel or the domain.
// =============================================================================

/** Normalized inbound message envelope, channel-agnostic. Every adapter MUST
 *  emit this shape regardless of the underlying wire format so the Gateway can
 *  route uniformly. `chatId` is a string so non-numeric channel ids (phone
 *  numbers, JIDs, room handles) fit without loss. */
export interface InboundMessage {
  /** The adapter id that produced this message, e.g. "telegram". */
  channel: string;
  /** Channel-native conversation id (numeric chat id, phone number, JID, ...). */
  chatId: string;
  /** Optional thread/topic id within the conversation, when the channel has one. */
  threadId?: string;
  /** The plain-text body of the message. */
  text: string;
  /** Unix epoch milliseconds when the adapter observed the message. */
  ts: number;
}

/** Callback the Gateway installs on each adapter. Adapters invoke it once per
 *  inbound message. It returns a promise so adapters can backpressure if they
 *  want to await processing (Telegram's long-poll does). */
export type InboundHandler = (msg: InboundMessage) => Promise<void>;

/** A messaging channel, normalized. The Gateway treats every channel through
 *  this single interface. */
export interface ChannelAdapter {
  /** Stable channel id, e.g. "telegram", "whatsapp". Used for routing tags,
   *  logging, and status. */
  readonly id: string;
  /** Begin receiving messages, delivering each as an InboundMessage to the
   *  handler. Resolves once the adapter is up (it keeps running in the
   *  background). */
  start(handler: InboundHandler): Promise<void>;
  /** Stop receiving and release resources (sockets, timers, child processes). */
  stop(): void;
  /** Deliver an outbound text message to a channel-native chat id. */
  send(chatId: string, text: string): Promise<void>;
}
