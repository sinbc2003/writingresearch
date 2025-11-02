import createError from 'http-errors';

const DICTIONARY_BASE = 'https://api.dictionaryapi.dev/api/v2/entries/en';

function hasHangul(text) {
  return /[\u3131-\u318E\uAC00-\uD7A3]/.test(text);
}

async function translate(text, source, target, endpoint) {
  if (!endpoint) return '';
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, source, target, format: 'text' })
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`번역 API 오류: ${errText}`);
    }
    const result = await response.json();
    return result?.translatedText || '';
  } catch (error) {
    console.error('번역 API 호출 실패', error);
    return '';
  }
}

async function fetchEnglishDictionary(word) {
  const response = await fetch(`${DICTIONARY_BASE}/${encodeURIComponent(word)}`);
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw createError(404, err?.message || '사전 결과를 찾지 못했습니다.');
  }
  return response.json();
}

function buildDictionaryPayload({ query, direction, dictionaryData, translation }) {
  const firstEntry = Array.isArray(dictionaryData) ? dictionaryData[0] : null;
  const phonetic = firstEntry?.phonetic || (firstEntry?.phonetics?.find((item) => item.text)?.text ?? '');
  const entries = Array.isArray(dictionaryData)
    ? dictionaryData.flatMap((entry) =>
        (entry.meanings || []).map((meaning) => ({
          pos: meaning.partOfSpeech || '',
          meanings: (meaning.definitions || []).map((def) => def.definition).filter(Boolean)
        }))
      )
    : [];
  const examples = Array.isArray(dictionaryData)
    ? dictionaryData
        .flatMap((entry) =>
          (entry.meanings || []).flatMap((meaning) =>
            (meaning.definitions || [])
              .filter((def) => Boolean(def.example))
              .map((def) => ({
                en: def.example,
                ko: ''
              }))
          )
        )
        .slice(0, 5)
    : [];

  return {
    word: query,
    direction,
    pronunciation: phonetic,
    translation,
    entries,
    examples
  };
}

export function createDictionaryService(config) {
  const translatorEndpoint = config?.dictionary?.libreTranslateUrl;

  return {
    async lookup(query) {
      const cleaned = String(query || '').trim();
      if (!cleaned) throw createError(400, '검색어를 입력하세요.');
      const isHangul = hasHangul(cleaned);
      if (isHangul) {
        const translation = await translate(cleaned, 'ko', 'en', translatorEndpoint);
        return {
          word: cleaned,
          direction: 'ko-en',
          pronunciation: '',
          translation,
          entries: [],
          examples: []
        };
      }
      const dictionaryData = await fetchEnglishDictionary(cleaned);
      const translation = await translate(cleaned, 'en', 'ko', translatorEndpoint);
      return buildDictionaryPayload({
        query: cleaned,
        direction: 'en-ko',
        dictionaryData,
        translation
      });
    }
  };
}

