import type { ChatState, Message } from "./types";

const EMPTY_MESSAGES: readonly [] = [];

export const chatSelectors = {
  activeSession: (s: ChatState) => (s.activeSessionId ? s.sessions[s.activeSessionId] ?? null : null),
  activeMessages: (s: ChatState) =>
    (s.activeSessionId ? s.sessions[s.activeSessionId]?.messages : undefined) ?? EMPTY_MESSAGES,
  activeMessageCount: (s: ChatState) =>
    (s.activeSessionId ? s.sessions[s.activeSessionId]?.messages.length : undefined) ?? 0,
  /** Return [timestamp, index] pairs so <ChatPage> can iterate without pulling the whole message array. */
  activeMessageKeys: (s: ChatState): ReadonlyArray<[number, number]> => {
    if (!s.activeSessionId) return [];
    const msgs = s.sessions[s.activeSessionId]?.messages;
    if (!msgs) return [];
    const keys: Array<[number, number]> = [];
    for (let i = 0; i < msgs.length; i += 1) keys.push([msgs[i]!.timestamp, i]);
    return keys;
  },
  /** Pull a single message by its index in the active session; null when missing. */
  messageAtActiveSessionIndex: (index: number) => (s: ChatState): Message | null => {
    if (!s.activeSessionId) return null;
    const msgs = s.sessions[s.activeSessionId]?.messages;
    if (!msgs || index < 0 || index >= msgs.length) return null;
    return msgs[index] ?? null;
  },
  /** Pull the very last message; used by the "still streaming?" indicator. */
  lastActiveMessage: (s: ChatState): Message | null => {
    if (!s.activeSessionId) return null;
    const msgs = s.sessions[s.activeSessionId]?.messages;
    if (!msgs || msgs.length === 0) return null;
    return msgs[msgs.length - 1] ?? null;
  },
  isActiveSessionStreaming: (s: ChatState) => Boolean(s.activeSessionId && s.sessions[s.activeSessionId]?.isStreaming),
  // 聊天轮本身是否在流式中；后台任务运行期间为 false（此时仍可继续发消息）。
  isActiveSessionChatStreaming: (s: ChatState) =>
    Boolean(s.activeSessionId && s.sessions[s.activeSessionId]?.isChatStreaming),
  // 上一条失败的聊天轮发送记录；存在且非聊天流式中时 UI 显示"重试"按钮。
  activeSessionLastFailedSend: (s: ChatState) =>
    (s.activeSessionId ? s.sessions[s.activeSessionId]?.lastFailedSend : undefined) ?? null,
  isEmpty: (s: ChatState) =>
    ((s.activeSessionId ? s.sessions[s.activeSessionId]?.messages.length : 0) ?? 0) === 0
    && !Boolean(s.activeSessionId && s.sessions[s.activeSessionId]?.isStreaming),
};
