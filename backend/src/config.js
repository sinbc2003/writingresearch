import process from 'node:process';

const DEFAULT_ALLOWED_ORIGINS = ['*'];

const config = {
  port: Number(process.env.PORT || 8080),
  projectId: process.env.GCP_PROJECT_ID || process.env.PROJECT_ID || 'writingresearch',
  dataBucket: process.env.DATA_BUCKET || null,
  localDataDir: process.env.LOCAL_DATA_DIR || '../local-data',
  apiKey: process.env.API_KEY || null,
  allowedOrigins: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((value) => value.trim()).filter(Boolean)
    : DEFAULT_ALLOWED_ORIGINS,
  ai: {
    enabled: Boolean(process.env.VERTEX_MODEL),
    model: process.env.VERTEX_MODEL || 'gemini-1.5-flash',
    location: process.env.VERTEX_LOCATION || 'us-central1',
    systemPrompt: process.env.AI_SYSTEM_PROMPT || `당신은 영어 글쓰기 튜터입니다. 학생이 작성한 영어 글을 기반으로 개선 아이디어를 제안하고, 질문에 친절하게 답하세요.`,
    temperature: process.env.AI_TEMPERATURE ? Number(process.env.AI_TEMPERATURE) : 0.6
  },
  dictionary: {
    provider: process.env.DICTIONARY_PROVIDER || 'dictionaryapi',
    libreTranslateUrl: process.env.LIBRE_TRANSLATE_URL || 'https://libretranslate.de/translate'
  }
};

export default config;

