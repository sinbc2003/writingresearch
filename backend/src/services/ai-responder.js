import { VertexAI } from '@google-cloud/vertexai';

function buildContents(history, userMessage) {
  const recent = Array.isArray(history) ? history.slice(-12) : [];
  const mapped = recent
    .map((entry) => {
      if (!entry || !entry.text) return null;
      const role = entry.role === 'ai' ? 'model' : entry.role === 'system' ? 'user' : 'user';
      return {
        role,
        parts: [{ text: String(entry.text) }]
      };
    })
    .filter(Boolean);
  mapped.push({ role: 'user', parts: [{ text: String(userMessage) }] });
  return mapped;
}

function buildFallbackResponse(userMessage) {
  const suggestions = `다음 제안을 참고해 보세요:\n1. 핵심 주장 명확히 하기\n2. 근거를 구체적인 예시로 보강하기\n3. 문장 간 연결어를 점검하기`;
  return `${userMessage ? '질문해 주신 내용 잘 읽었습니다.' : '안녕하세요!'}\n\n${suggestions}`;
}

export function createAiResponder(config) {
  if (!config || !config.ai || !config.ai.enabled) {
    return {
      isEnabled: () => false,
      async generateReply({ userMessage }) {
        return buildFallbackResponse(userMessage);
      }
    };
  }

  const vertexAI = new VertexAI({
    project: config.projectId,
    location: config.ai.location || 'us-central1'
  });

  const generativeModel = vertexAI.preview.getGenerativeModel({
    model: config.ai.model,
    systemInstruction: {
      parts: [{ text: config.ai.systemPrompt }]
    }
  });

  return {
    isEnabled: () => true,
    async generateReply({ userMessage, history }) {
      if (!userMessage || !userMessage.trim()) {
        return '';
      }
      try {
        const contents = buildContents(history, userMessage);
        const result = await generativeModel.generateContent({
          contents,
          generationConfig: {
            temperature: config.ai.temperature ?? 0.6,
            maxOutputTokens: 1024
          }
        });
        const text = result?.response?.candidates?.[0]?.content?.parts
          ?.map((part) => part.text || '')
          .join('')
          .trim();
        return text || buildFallbackResponse(userMessage);
      } catch (error) {
        console.error('AI 응답 생성 오류', error);
        return buildFallbackResponse(userMessage);
      }
    }
  };
}

