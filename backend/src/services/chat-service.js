import createError from 'http-errors';

const CHANNEL_MAP = {
  'ai-feedback': 'ai',
  'peer-chat': 'peer'
};

function resolveChannel(channel) {
  if (!channel) return 'ai';
  if (CHANNEL_MAP[channel]) return CHANNEL_MAP[channel];
  if (channel === 'ai' || channel === 'peer') return channel;
  return 'ai';
}

export function createChatService(dataStore, aiResponder) {
  if (!dataStore) throw new Error('dataStore가 필요합니다.');

  async function postMessage(sessionId, group, userId, userName, role, text, metadata = {}) {
    if (!sessionId) throw createError(400, '세션 ID가 필요합니다.');
    const cleaned = String(text || '').trim();
    if (!cleaned) throw createError(400, '메시지를 입력하세요.');
    const channel = resolveChannel(metadata.channel);
    const now = Date.now();
    const message = {
      ts: now,
      role: role || 'user',
      senderId: userId || null,
      senderName: userName || null,
      text: cleaned,
      metadata: {
        ...metadata,
        group
      }
    };
    await dataStore.appendChatMessage(sessionId, channel, message);
    return message;
  }

  async function getMessages(sessionId, lastTs = 0, channel = 'ai') {
    if (!sessionId) throw createError(400, '세션 ID가 필요합니다.');
    const resolved = resolveChannel(channel);
    return dataStore.getChatMessages(sessionId, resolved, Number(lastTs || 0));
  }

  async function requestAiIfNeeded(sessionId, group, userMessage, context, metadata = {}) {
    if (!sessionId) throw createError(400, '세션 ID가 필요합니다.');
    if (!aiResponder) {
      return { ok: false, reason: 'ai_disabled' };
    }
    const history = await dataStore.getChatHistory(sessionId, 'ai');
    const responseText = await aiResponder.generateReply({
      group,
      userMessage,
      context,
      history
    });
    if (!responseText) {
      return { ok: false, reason: aiResponder.isEnabled && aiResponder.isEnabled() ? 'empty_response' : 'ai_disabled' };
    }
    const now = Date.now();
    const message = {
      ts: now,
      role: 'ai',
      senderId: 'ai',
      senderName: 'AI Tutor',
      text: responseText,
      metadata: {
        ...metadata,
        group
      }
    };
    await dataStore.appendChatMessage(sessionId, 'ai', message);
    return { ok: true, text: responseText, ts: now };
  }

  return {
    postMessage,
    getMessages,
    requestAiIfNeeded
  };
}

