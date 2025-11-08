import createError from 'http-errors';
import OpenAI from 'openai';

const DEFAULT_MODEL = 'gpt-4.1-mini';
const DEFAULT_TEMPERATURE = 0.2;
const JSON_MATCHER = /\{[\s\S]*\}/;

const DICTIONARY_SYSTEM_PROMPT = `
당신은 양방향 사전 API의 응답을 생성하는 언어모델입니다.
입력된 단어의 언어(영어 또는 한국어)를 자동으로 감지하여,
영어 입력 시 "영한사전", 한국어 입력 시 "한영사전" 형식으로 동일한 JSON 구조를 출력하십시오.
사용자로부터 전달되는 메시지는 JSON이며, "sourceLanguage"와 "targetLanguage" 키가 포함되어 있습니다.
항상 이 값을 우선으로 사용하여 입력/출력 언어를 판단하고, 지시와 일치하지 않는 언어를 사용하지 마십시오.

[출력 형식]

{
  "word": "입력된 단어 그대로",
  "pronunciation": "IPA 발음 기호 (영어 단어일 경우만 기입, 없으면 빈 문자열)",
  "entries": [
    {
      "pos": "품사 (예: 명사, 동사, 형용사 등 — 한국어로 표기)",
      "meanings": ["뜻1", "뜻2", "뜻3"]
    }
  ],
  "examples": [
    { "en": "영어 문장 1", "ko": "한국어 번역 1" },
    { "en": "영어 문장 2", "ko": "한국어 번역 2" }
  ]
}

[세부 규칙]

1. 반드시 위 JSON 구조만 출력합니다. 다른 텍스트, 설명, 마크다운, 주석을 절대 포함하지 않습니다.
2. "entries" 안의 "meanings" 배열은 간결하고 핵심적인 뜻만 나열합니다 (최대 3개).
3. "examples" 배열은 항상 2개만 포함합니다.
   - 영한사전일 경우: 영어 예문 → 한국어 번역
   - 한영사전일 경우: 한국어 예문 → 영어 번역
4. "pronunciation"은 영어 단어일 때만 작성합니다. 한국어 단어일 경우 빈 문자열로 둡니다.
5. "pos"는 한국어 품사명만 사용합니다 ("명사", "동사", "형용사", "부사" 등).
6. 출력은 정규식으로 파싱하기 쉽게 하기 위해 JSON 구문을 절대 벗어나지 않습니다.
7. 단어의 의미는 사전적 정의를 중심으로 하되, 예문은 자연스럽고 짧은 일상 문장으로 작성합니다.
8. 영어 입력이면 meanings 배열은 반드시 한국어 뜻으로 작성하고, 한국어 입력이면 meanings 배열은 반드시 영어 뜻으로 작성합니다.
9. 예문의 "en"과 "ko" 값은 각각 targetLanguage, sourceLanguage에 맞는 언어로 작성하고, 서로 다른 언어를 섞지 않습니다.
10. 위 지침을 지킬 수 없다면 JSON 대신 오류 메시지를 출력하는 것이 아니라, 정확한 언어로 다시 작성하여 JSON만 반환하십시오.
`.trim();

function hasHangul(text) {
  return /[\u3131-\u318E\uAC00-\uD7A3]/.test(text);
}

function determineLanguages(term) {
  const input = String(term || '').trim();
  const containsHangul = hasHangul(input);
  const containsLatin = /[A-Za-z]/.test(input);
  if (containsHangul && !containsLatin) {
    return { direction: 'ko-en', sourceLanguage: 'ko', targetLanguage: 'en' };
  }
  if (!containsHangul && containsLatin) {
    return { direction: 'en-ko', sourceLanguage: 'en', targetLanguage: 'ko' };
  }
  if (containsHangul) {
    return { direction: 'ko-en', sourceLanguage: 'ko', targetLanguage: 'en' };
  }
  return { direction: 'en-ko', sourceLanguage: 'en', targetLanguage: 'ko' };
}

function normalizeEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => {
      const pos = entry?.pos ? String(entry.pos).trim() : '';
      const meanings = Array.isArray(entry?.meanings)
        ? entry.meanings.map((meaning) => String(meaning || '').trim()).filter(Boolean)
        : [];
      return { pos, meanings };
    })
    .filter((entry) => entry.pos || entry.meanings.length);
}

function normalizeExamples(examples) {
  if (!Array.isArray(examples)) return [];
  return examples
    .map((example) => {
      let enText = example?.en ? String(example.en).trim() : '';
      let koText = example?.ko ? String(example.ko).trim() : '';
      const enHasHangul = hasHangul(enText);
      const koHasHangul = hasHangul(koText);
      if (enHasHangul && !koHasHangul) {
        const swappedEn = koText;
        const swappedKo = enText;
        enText = swappedEn;
        koText = swappedKo;
      }
      return { en: enText, ko: koText };
    })
    .filter((example) => example.en || example.ko)
    .slice(0, 2);
}

function normalizeDictionaryData(data, { term, direction }) {
  const word = data?.word ? String(data.word).trim() : term;
  const pronunciation = data?.pronunciation ? String(data.pronunciation).trim() : '';
  const entries = normalizeEntries(data?.entries);
  const examples = normalizeExamples(data?.examples);
  const translation =
    typeof data?.translation === 'string' && data.translation.trim()
      ? data.translation.trim()
      : entries?.[0]?.meanings?.[0] || '';
  return {
    word,
    direction,
    pronunciation,
    translation,
    entries,
    examples
  };
}

function parseDictionaryResponse(raw, fallbackTerm) {
  if (!raw) {
    throw createError(502, '사전 응답이 비어 있습니다.');
  }
  const trimmed = String(raw).trim();
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    const match = trimmed.match(JSON_MATCHER);
    if (!match) {
      throw createError(502, '사전 응답을 JSON으로 파싱하지 못했습니다.');
    }
    try {
      parsed = JSON.parse(match[0]);
    } catch (err) {
      throw createError(502, `사전 JSON 파싱 오류: ${err.message}`);
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    throw createError(502, '사전 응답 구조가 올바르지 않습니다.');
  }
  if (!parsed.word) parsed.word = fallbackTerm;
  return parsed;
}

export function createDictionaryService(config) {
  const dictionaryConfig = config?.dictionary || {};
  const aiConfig = config?.ai || {};
  const openaiConfig = aiConfig.openai || {};

  const apiKey = openaiConfig.apiKey || process.env.OPENAI_API_KEY || '';
  const baseUrl = openaiConfig.baseUrl || process.env.OPENAI_BASE_URL || '';
  const organization = openaiConfig.organization || process.env.OPENAI_ORG || '';
  const model = dictionaryConfig.openaiModel || openaiConfig.model || DEFAULT_MODEL;
  const systemPrompt = dictionaryConfig.systemPrompt?.trim()
    ? dictionaryConfig.systemPrompt.trim()
    : DICTIONARY_SYSTEM_PROMPT;
  const hasCustomTemp =
    dictionaryConfig.temperature !== undefined &&
    dictionaryConfig.temperature !== null &&
    dictionaryConfig.temperature !== '';
  const customTemp = Number(dictionaryConfig.temperature);
  const temperature = hasCustomTemp && Number.isFinite(customTemp) ? customTemp : DEFAULT_TEMPERATURE;

  let openai = null;
  if (apiKey) {
    const clientOptions = { apiKey };
    if (baseUrl) clientOptions.baseURL = baseUrl;
    if (organization) clientOptions.organization = organization;
    openai = new OpenAI(clientOptions);
  }

  async function requestDictionary(term, sourceLanguage, targetLanguage) {
    if (!openai) {
      throw createError(500, '사전 기능을 위한 OpenAI API 키가 설정되지 않았습니다.');
    }
    const payload = {
      request: 'bidirectional_dictionary_lookup',
      term,
      sourceLanguage,
      targetLanguage
    };
    try {
      const response = await openai.chat.completions.create({
        model,
        temperature,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: JSON.stringify(payload) }
        ],
        max_tokens: 800
      });
      const content = response?.choices?.[0]?.message?.content;
      return parseDictionaryResponse(content, term);
    } catch (error) {
      console.error('사전 OpenAI 호출 실패', error);
      if (error.status && typeof error.status === 'number') {
        throw error;
      }
      throw createError(502, '사전 서비스를 호출하는 데 실패했습니다.');
    }
  }

  return {
    async lookup(query) {
      const cleaned = String(query || '').trim();
      if (!cleaned) throw createError(400, '검색어를 입력하세요.');
      const { direction, sourceLanguage, targetLanguage } = determineLanguages(cleaned);
      const rawData = await requestDictionary(cleaned, sourceLanguage, targetLanguage);
      return normalizeDictionaryData(rawData, { term: cleaned, direction });
    }
  };
}

