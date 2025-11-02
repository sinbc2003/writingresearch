/**
 * 영어 글쓰기 워크스페이스 세션 및 단계 관리
 */

var WRITING_SHEET_NAME = 'writing_sessions';
var WRITING_HEADERS = [
  'sessionKey',
  'group',
  'studentId',
  'studentName',
  'roomId',
  'stage',
  'preText',
  'preSubmittedAt',
  'draftText',
  'draftSavedAt',
  'notesText',
  'notesUpdatedAt',
  'finalText',
  'finalSubmittedAt',
  'partnerStudentId',
  'partnerName',
  'createdAt',
  'updatedAt'
];

var WORKBOOK_PROP_PREFIX = 'WORKBOOK_ID_';
var WORKBOOK_SHEET_NAMES = {
  PRE: '사전 글쓰기',
  MEMO: '메모',
  FINAL: '사후 글쓰기',
  AI: 'AI 대화',
  PEER: '동료 대화'
};

var DICTIONARY_MODEL = 'gpt-4.1-mini';
var DICTIONARY_SYSTEM_PROMPT = [
  '당신은 양방향 사전 API의 응답을 생성하는 언어모델입니다.',
  '입력된 단어의 언어(영어 또는 한국어)를 자동으로 감지하여,',
  '영어 입력 시 "영한사전", 한국어 입력 시 "한영사전" 형식으로 동일한 JSON 구조를 출력하십시오.',
  '사용자로부터 전달되는 메시지는 JSON이며, "sourceLanguage"와 "targetLanguage" 키가 포함되어 있습니다.',
  '항상 이 값을 우선으로 사용하여 입력/출력 언어를 판단하고, 지시와 일치하지 않는 언어를 사용하지 마십시오.',
  '',
  '다음 규칙을 반드시 따르십시오.',
  '',
  '[출력 형식]',
  '',
  '{',
  '  "word": "입력된 단어 그대로",',
  '  "pronunciation": "IPA 발음 기호 (영어 단어일 경우만 기입, 없으면 빈 문자열)",',
  '  "entries": [',
  '    {',
  '      "pos": "품사 (예: 명사, 동사, 형용사 등 — 한국어로 표기)",',
  '      "meanings": ["뜻1", "뜻2", "뜻3"]',
  '    },',
  '    ...',
  '  ],',
  '  "examples": [',
  '    { "en": "영어 문장 1", "ko": "한국어 번역 1" },',
  '    { "en": "영어 문장 2", "ko": "한국어 번역 2" }',
  '  ]',
  '}',
  '',
  '[세부 규칙]',
  '',
  '1. 반드시 위 JSON 구조만 출력합니다. 다른 텍스트, 설명, 마크다운, 주석을 절대 포함하지 않습니다.',
  '2. "entries" 안의 "meanings" 배열은 간결하고 핵심적인 뜻만 나열합니다 (최대 3개).',
  '3. "examples" 배열은 항상 2개만 포함합니다.',
  '   - 영한사전일 경우: 영어 예문 → 한국어 번역',
  '   - 한영사전일 경우: 한국어 예문 → 영어 번역',
  '4. "pronunciation"은 영어 단어일 때만 작성합니다. (예: "/rʌn/"). 한국어 단어일 경우 빈 문자열로 둡니다.',
  '5. "pos"는 한국어 품사명만 사용합니다 ("명사", "동사", "형용사", "부사", 등).',
  '6. 출력은 정규식으로 파싱하기 쉽게 하기 위해 JSON 구문을 절대 벗어나지 않습니다.',
  '7. 단어의 의미는 사전적 정의를 중심으로 하되, 예문은 자연스럽고 짧은 일상 문장으로 작성합니다.',
  '8. 영어 입력이면 meanings 배열은 반드시 한국어 뜻으로 작성하고, 한국어 입력이면 meanings 배열은 반드시 영어 뜻으로 작성합니다.',
  '9. 예문은 첫 줄에 입력 언어 문장을, 둘째 줄에 번역 언어 문장을 배치합니다.',
  '10. meanings 배열과 examples의 "en"/"ko" 값은 각각 targetLanguage 및 sourceLanguage에 맞는 언어로 작성해야 하며, 다른 언어를 사용하지 않습니다.',
  '11. 위 지침을 지킬 수 없다면 JSON 대신 오류 메시지를 출력하는 것이 아니라, 정확한 언어로 다시 작성하여 JSON만 반환하십시오.'
].join('\n');

function getWritingSheet_() {
  var ss = getOrCreateDataSpreadsheet_();
  var sh = ss.getSheetByName(WRITING_SHEET_NAME) || ss.insertSheet(WRITING_SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.appendRow(WRITING_HEADERS);
  }
  return sh;
}

function buildSessionKey_(group, studentId) {
  var g = String(group || '').toUpperCase();
  var sid = String(studentId || '').trim();
  if (!g || !sid) throw new Error('세션 키를 생성하려면 집단과 식별 번호가 필요합니다.');
  return g + '|' + sid;
}

function parseSessionKey_(key) {
  var raw = String(key || '').trim();
  if (!raw) throw new Error('세션 키가 비어 있습니다.');
  var parts = raw.split('|');
  if (parts.length < 2) throw new Error('세션 키 형식이 올바르지 않습니다.');
  var group = parts[0];
  var studentId = parts.slice(1).join('|');
  return { group: group, studentId: studentId };
}

function makeSoloRoomId_(group, studentId) {
  var base = String(group || '').toUpperCase() + '|' + String(studentId || '').trim();
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, base);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var h = (bytes[i] & 0xff).toString(16);
    if (h.length === 1) h = '0' + h;
    hex += h;
  }
  return 'solo_' + hex.substring(0, 12);
}

function readPresence_(roomId, studentId) {
  if (!roomId || !studentId) return 0;
  try {
    var cache = CacheService.getScriptCache();
    var key = buildPresenceCacheKey_(roomId, studentId);
    var val = cache.get(key);
    return val ? Number(val) : 0;
  } catch (e) {
    return 0;
  }
}

function buildPresenceCacheKey_(roomId, studentId) {
  return 'presence|' + String(roomId || '').trim() + '|' + String(studentId || '').trim();
}

function writePresence_(roomId, studentId, millis) {
  if (!roomId || !studentId) return;
  var cache = CacheService.getScriptCache();
  cache.put(buildPresenceCacheKey_(roomId, studentId), String(millis), 60);
}

function getWorkbookPropertyKey_(sessionKey) {
  return WORKBOOK_PROP_PREFIX + String(sessionKey || '').trim();
}

function getSessionRecordBySessionKey_(sessionKey) {
  if (!sessionKey) return null;
  var parsed;
  try { parsed = parseSessionKey_(sessionKey); } catch (e) { return null; }
  var lookup = findWritingSessionRow_(parsed.group, parsed.studentId);
  return lookup.record;
}

function ensureWorkbookForSession_(sessionKey, record) {
  if (!sessionKey) return null;
  var props = PropertiesService.getScriptProperties();
  var key = getWorkbookPropertyKey_(sessionKey);
  var workbookId = props.getProperty(key);
  var ss = null;
  if (workbookId) {
    try { ss = SpreadsheetApp.openById(workbookId); }
    catch (e) { ss = null; }
  }
  if (!ss) {
    if (!record) record = getSessionRecordBySessionKey_(sessionKey);
    if (!record) return null;
    var nameParts = [String(record.group || '').toUpperCase(), String(record.studentId || '').trim(), String(record.studentName || '').trim()].filter(function(s){ return !!s; });
    var filename = nameParts.length ? nameParts.join('_') : sessionKey;
    ss = SpreadsheetApp.create(filename);
    try {
      var file = DriveApp.getFileById(ss.getId());
      var folderId = readUserSetting_(USERPROP_CONV_FOLDER_ID) || '';
      if (folderId) {
        var folder = DriveApp.getFolderById(folderId);
        folder.addFile(file);
        var parents = file.getParents();
        while (parents.hasNext()) {
          var parent = parents.next();
          if (parent.getId() !== folderId) parent.removeFile(file);
        }
      }
    } catch (e) {}
    setupWorkbookSheets_(ss);
    props.setProperty(key, ss.getId());
  }
  return ss;
}

function setupWorkbookSheets_(ss) {
  var definitions = [
    { name: WORKBOOK_SHEET_NAMES.PRE, headers: ['작성 시각', '내용'] },
    { name: WORKBOOK_SHEET_NAMES.MEMO, headers: ['단계', '작성 시각', '내용'] },
    { name: WORKBOOK_SHEET_NAMES.FINAL, headers: ['제출 시각', '내용'] },
    { name: WORKBOOK_SHEET_NAMES.AI, headers: ['시간', '이름', '역할', '메시지'] },
    { name: WORKBOOK_SHEET_NAMES.PEER, headers: ['시간', '이름', '역할', '메시지'] }
  ];
  var sheets = ss.getSheets();
  if (sheets.length) {
    sheets[0].setName(definitions[0].name);
    setupWorkbookSheetHeader_(sheets[0], definitions[0].headers);
  }
  for (var i = 1; i < definitions.length; i++) {
    var sheet = ss.getSheetByName(definitions[i].name);
    if (!sheet) sheet = ss.insertSheet(definitions[i].name);
    setupWorkbookSheetHeader_(sheet, definitions[i].headers);
  }
  var keepNames = {};
  definitions.forEach(function(def){ keepNames[def.name] = true; });
  sheets = ss.getSheets();
  for (var j = 0; j < sheets.length; j++) {
    if (!keepNames[sheets[j].getName()]) {
      ss.deleteSheet(sheets[j]);
    }
  }
}

function setupWorkbookSheetHeader_(sheet, headers) {
  sheet.clear();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
}

function writePrewritingToWorkbook_(record) {
  if (!record || !record.sessionKey) return;
  var ss = ensureWorkbookForSession_(record.sessionKey, record);
  if (!ss) return;
  var sheet = ss.getSheetByName(WORKBOOK_SHEET_NAMES.PRE) || ss.insertSheet(WORKBOOK_SHEET_NAMES.PRE);
  sheet.clear();
  sheet.getRange(1, 1, 1, 2).setValues([['작성 시각', '내용']]);
  sheet.setFrozenRows(1);
  if (record.preText) {
    sheet.getRange(2, 1, 1, 2).setValues([[new Date(record.preSubmittedAt || Date.now()), record.preText]]);
    sheet.getRange(2, 1).setNumberFormat('yyyy-mm-dd HH:mm:ss');
    sheet.autoResizeColumns(1, 2);
  }
}

function writeMemoToWorkbook_(record, stageLabel, content, timestamp) {
  if (!record || !record.sessionKey) return;
  var ss = ensureWorkbookForSession_(record.sessionKey, record);
  if (!ss) return;
  var sheet = ss.getSheetByName(WORKBOOK_SHEET_NAMES.MEMO) || ss.insertSheet(WORKBOOK_SHEET_NAMES.MEMO);
  var rows = [];
  var last = sheet.getLastRow();
  if (last > 1) {
    rows = sheet.getRange(2, 1, last - 1, 3).getValues();
  }
  var updated = false;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]) === stageLabel) {
      rows[i][1] = new Date(timestamp || Date.now());
      rows[i][2] = content || '';
      updated = true;
      break;
    }
  }
  if (!updated) {
    rows.push([stageLabel, new Date(timestamp || Date.now()), content || '']);
  }
  rows.sort(function(a, b) {
    var order = {
      '2단계 메모': 1,
      '3단계 메모': 2
    };
    var av = order[a[0]] || 99;
    var bv = order[b[0]] || 99;
    return av - bv;
  });
  sheet.clear();
  sheet.getRange(1, 1, 1, 3).setValues([['단계', '작성 시각', '내용']]);
  sheet.setFrozenRows(1);
  if (rows.length) {
    var preparedRows = rows.map(function(row){
      return [
        row[0],
        row[1] instanceof Date ? row[1] : (row[1] ? new Date(row[1]) : ''),
        row[2]
      ];
    });
    sheet.getRange(2, 1, preparedRows.length, 3).setValues(preparedRows);
    sheet.getRange(2, 2, preparedRows.length, 1).setNumberFormat('yyyy-mm-dd HH:mm:ss');
    sheet.autoResizeColumns(1, 3);
  }
}

function writeFinalWritingToWorkbook_(record) {
  if (!record || !record.sessionKey) return;
  var ss = ensureWorkbookForSession_(record.sessionKey, record);
  if (!ss) return;
  var sheet = ss.getSheetByName(WORKBOOK_SHEET_NAMES.FINAL) || ss.insertSheet(WORKBOOK_SHEET_NAMES.FINAL);
  sheet.clear();
  sheet.getRange(1, 1, 1, 2).setValues([['제출 시각', '내용']]);
  sheet.setFrozenRows(1);
  sheet.getRange(2, 1, 1, 2).setValues([[new Date(record.finalSubmittedAt || Date.now()), record.finalText || '']]);
  sheet.getRange(2, 1).setNumberFormat('yyyy-mm-dd HH:mm:ss');
  sheet.autoResizeColumns(1, 2);
}

function appendChatToWorkbook_(sessionKey, channel, entry) {
  if (!sessionKey || !channel) return;
  var record = getSessionRecordBySessionKey_(sessionKey);
  if (!record) return;
  var sheetName = null;
  if (channel === 'ai-feedback') sheetName = WORKBOOK_SHEET_NAMES.AI;
  else if (channel === 'peer-chat') sheetName = WORKBOOK_SHEET_NAMES.PEER;
  if (!sheetName) return;
  appendChatToWorkbookForRecord_(record, sheetName, entry);
  if (channel === 'peer-chat' && record.partnerStudentId) {
    try {
      var partnerKey = buildSessionKey_(record.group, record.partnerStudentId);
      var partnerRecord = getSessionRecordBySessionKey_(partnerKey);
      if (partnerRecord) {
        appendChatToWorkbookForRecord_(partnerRecord, sheetName, entry);
      }
    } catch (e) {}
  }
}

function appendChatToWorkbookForRecord_(record, sheetName, entry) {
  if (!entry || !record) return;
  var ss = ensureWorkbookForSession_(record.sessionKey, record);
  if (!ss) return;
  var sheet = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, 4).setValues([['시간', '이름', '역할', '메시지']]);
    sheet.setFrozenRows(1);
  }
  sheet.appendRow([new Date(entry.ts || Date.now()), entry.senderName || '', entry.role || '', entry.text || '']);
  sheet.getRange(sheet.getLastRow(), 1).setNumberFormat('yyyy-mm-dd HH:mm:ss');
  sheet.autoResizeColumns(1, 4);
}

function findWritingSessionRow_(group, studentId) {
  var key = buildSessionKey_(group, studentId);
  var sh = getWritingSheet_();
  var range = sh.getDataRange();
  var values = range.getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0] || '') === key) {
      return { rowIndex: i + 1, record: rowToWritingSession_(values[i]) };
    }
  }
  return { rowIndex: 0, record: null };
}

function ensureWritingSession_(group, studentId, studentName) {
  var now = Date.now();
  var key = buildSessionKey_(group, studentId);
  var lookup = findWritingSessionRow_(group, studentId);
  var record = lookup.record;
  var rowIndex = lookup.rowIndex;
  var upperGroup = String(group || '').toUpperCase();
  var needsPartner = upperGroup === 'A' || upperGroup === 'B';
  var match = needsPartner ? getMatchupForStudent_(studentId, studentName) : null;
  var desiredRoomId = '';
  var partnerId = '';
  var partnerName = '';
  if (match) {
    desiredRoomId = match.roomId || makePairRoomId_((match.studentIdA || match.nameA || ''), (match.studentIdB || match.nameB || ''));
    if (String(match.studentIdA || '') === String(studentId)) {
      partnerId = String(match.studentIdB || '');
      partnerName = String(match.nameB || '');
    } else {
      partnerId = String(match.studentIdA || '');
      partnerName = String(match.nameA || '');
    }
  } else {
    desiredRoomId = makeSoloRoomId_(group, studentId);
  }

  if (!record) {
    record = {
      sessionKey: key,
      group: String(group || '').toUpperCase(),
      studentId: String(studentId || '').trim(),
      studentName: String(studentName || '').trim(),
      roomId: desiredRoomId,
      stage: 1,
      preText: '',
      preSubmittedAt: 0,
      draftText: '',
      draftSavedAt: 0,
      notesText: '',
      notesUpdatedAt: 0,
      finalText: '',
      finalSubmittedAt: 0,
      partnerStudentId: partnerId,
      partnerName: partnerName,
      createdAt: now,
      updatedAt: now
    };
  } else {
    record.studentName = String(studentName || record.studentName || '');
    if (!record.roomId) record.roomId = desiredRoomId;
    if (desiredRoomId && record.roomId !== desiredRoomId) record.roomId = desiredRoomId;
    if (partnerId) {
      record.partnerStudentId = partnerId;
      if (partnerName) record.partnerName = partnerName;
    }
    record.updatedAt = now;
  }

  if (partnerId) {
    ensurePartnerMirrorRecord_(group, partnerId, partnerName, record.roomId, record.studentId, record.studentName);
  }

  var saved = saveWritingSession_(record, rowIndex);
  return saved;
}

function ensurePartnerMirrorRecord_(group, partnerStudentId, partnerName, roomId, yourId, yourName) {
  if (!partnerStudentId) return;
  var lookup = null;
  try {
    lookup = findWritingSessionRow_(group, partnerStudentId);
  } catch (e) {
    lookup = { rowIndex: 0, record: null };
  }
  var now = Date.now();
  if (lookup.record) {
    var rec = lookup.record;
    if (!rec.roomId) rec.roomId = roomId;
    if (roomId && rec.roomId !== roomId) rec.roomId = roomId;
    if (yourId) {
      rec.partnerStudentId = yourId;
      rec.partnerName = yourName || rec.partnerName;
    }
    rec.studentName = partnerName || rec.studentName;
    rec.updatedAt = now;
    saveWritingSession_(rec, lookup.rowIndex);
  } else {
    var fresh = {
      sessionKey: buildSessionKey_(group, partnerStudentId),
      group: String(group || '').toUpperCase(),
      studentId: String(partnerStudentId || '').trim(),
      studentName: String(partnerName || '').trim(),
      roomId: roomId,
      stage: 1,
      preText: '',
      preSubmittedAt: 0,
      draftText: '',
      draftSavedAt: 0,
      notesText: '',
      notesUpdatedAt: 0,
      finalText: '',
      finalSubmittedAt: 0,
      partnerStudentId: String(yourId || ''),
      partnerName: String(yourName || ''),
      createdAt: now,
      updatedAt: now
    };
    saveWritingSession_(fresh, 0);
  }
}

function saveWritingSession_(record, rowIndex) {
  var sh = getWritingSheet_();
  record.updatedAt = record.updatedAt || Date.now();
  if (!record.createdAt) record.createdAt = record.updatedAt;
  var row = writingSessionToRow_(record);
  if (rowIndex && rowIndex > 0) {
    sh.getRange(rowIndex, 1, 1, WRITING_HEADERS.length).setValues([row]);
  } else {
    sh.appendRow(row);
    rowIndex = sh.getLastRow();
  }
  record._rowIndex = rowIndex;
  return record;
}

function rowToWritingSession_(row) {
  return {
    sessionKey: String(row[0] || ''),
    group: String(row[1] || ''),
    studentId: String(row[2] || ''),
    studentName: String(row[3] || ''),
    roomId: String(row[4] || ''),
    stage: Number(row[5] || 1),
    preText: String(row[6] || ''),
    preSubmittedAt: Number(row[7] || 0),
    draftText: String(row[8] || ''),
    draftSavedAt: Number(row[9] || 0),
    notesText: String(row[10] || ''),
    notesUpdatedAt: Number(row[11] || 0),
    finalText: String(row[12] || ''),
    finalSubmittedAt: Number(row[13] || 0),
    partnerStudentId: String(row[14] || ''),
    partnerName: String(row[15] || ''),
    createdAt: Number(row[16] || 0),
    updatedAt: Number(row[17] || 0)
  };
}

function writingSessionToRow_(record) {
  return [
    record.sessionKey || '',
    record.group || '',
    record.studentId || '',
    record.studentName || '',
    record.roomId || '',
    Number(record.stage || 1),
    record.preText || '',
    Number(record.preSubmittedAt || 0),
    record.draftText || '',
    Number(record.draftSavedAt || 0),
    record.notesText || '',
    Number(record.notesUpdatedAt || 0),
    record.finalText || '',
    Number(record.finalSubmittedAt || 0),
    record.partnerStudentId || '',
    record.partnerName || '',
    Number(record.createdAt || 0),
    Number(record.updatedAt || 0)
  ];
}

function buildSessionStateResponse_(record) {
  if (!record) return null;
  var partnerRecord = null;
  if (record.partnerStudentId) {
    var partnerLookup = findWritingSessionRow_(record.group, record.partnerStudentId);
    partnerRecord = partnerLookup.record;
  }
  var presence = buildPresenceSummary_(record.roomId, record.studentId, record.partnerStudentId);
  var upperGroup = String(record.group || '').toUpperCase();
  var peerEnabled = upperGroup === 'A' || upperGroup === 'B';
  var state = {
    sessionKey: record.sessionKey,
    group: record.group,
    roomId: record.roomId,
    stage: Number(record.stage || 1),
    updatedAt: Number(record.updatedAt || 0),
    prewriting: {
      text: record.preText || '',
      submittedAt: Number(record.preSubmittedAt || 0)
    },
    draft: {
      text: record.draftText || '',
      savedAt: Number(record.draftSavedAt || 0)
    },
    notes: {
      text: record.notesText || '',
      updatedAt: Number(record.notesUpdatedAt || 0)
    },
    final: {
      text: record.finalText || '',
      submittedAt: Number(record.finalSubmittedAt || 0)
    },
    steps: {
      prewriting: {
        completed: !!record.preText,
        submittedAt: Number(record.preSubmittedAt || 0)
      },
      draft: {
        saved: !!record.draftText,
        savedAt: Number(record.draftSavedAt || 0)
      },
      peer: {
        enabled: peerEnabled,
        completed: peerEnabled ? Number(record.stage || 1) >= (upperGroup === 'B' ? 3 : 3) : false
      },
      final: {
        submitted: !!record.finalText,
        submittedAt: Number(record.finalSubmittedAt || 0)
      }
    },
    aiSessionId: 'ai:' + record.sessionKey,
    peerSessionId: (peerEnabled && record.roomId) ? 'peer:' + record.roomId : '',
    partner: null,
    presence: presence
  };
  if (partnerRecord) {
    state.partner = {
      id: partnerRecord.studentId,
      name: partnerRecord.studentName,
      stage: Number(partnerRecord.stage || 1),
      prewriting: {
        text: partnerRecord.preText || '',
        submittedAt: Number(partnerRecord.preSubmittedAt || 0)
      },
      draft: {
        text: partnerRecord.draftText || '',
        savedAt: Number(partnerRecord.draftSavedAt || 0)
      },
      notes: {
        text: partnerRecord.notesText || '',
        updatedAt: Number(partnerRecord.notesUpdatedAt || 0)
      },
      final: {
        text: partnerRecord.finalText || '',
        submittedAt: Number(partnerRecord.finalSubmittedAt || 0)
      },
      presence: presence.partner || null
    };
  }
  return state;
}

function buildPresenceSummary_(roomId, studentId, partnerStudentId) {
  var now = Date.now();
  var selfTs = readPresence_(roomId, studentId);
  var partnerTs = partnerStudentId ? readPresence_(roomId, partnerStudentId) : 0;
  var ttl = 20000; // 20초 동안 활동하면 온라인으로 간주
  return {
    self: {
      lastSeen: selfTs,
      online: selfTs && (now - selfTs) < ttl
    },
    partner: partnerStudentId ? {
      lastSeen: partnerTs,
      online: partnerTs && (now - partnerTs) < ttl
    } : null
  };
}

function getSessionState(sessionKey) {
  var parsed = parseSessionKey_(sessionKey);
  var lookup = findWritingSessionRow_(parsed.group, parsed.studentId);
  if (!lookup.record) throw new Error('세션을 찾을 수 없습니다.');
  return buildSessionStateResponse_(lookup.record);
}

function submitPrewriting(sessionKey, text) {
  var parsed = parseSessionKey_(sessionKey);
  var lookup = findWritingSessionRow_(parsed.group, parsed.studentId);
  if (!lookup.record) throw new Error('세션을 찾을 수 없습니다.');
  var record = lookup.record;
  if (record.preText) throw new Error('이미 사전 글쓰기가 제출되었습니다.');
  var content = String(text || '').trim();
  if (!content) throw new Error('사전 글쓰기 내용을 입력하세요.');
  var now = Date.now();
  record.preText = content;
  record.preSubmittedAt = now;
  if (Number(record.stage || 1) < 2) record.stage = 2;
  record.updatedAt = Date.now();
  saveWritingSession_(record, lookup.rowIndex);
  writePrewritingToWorkbook_(record);
  return buildSessionStateResponse_(record);
}

function savePostDraft(sessionKey, text) {
  var parsed = parseSessionKey_(sessionKey);
  var lookup = findWritingSessionRow_(parsed.group, parsed.studentId);
  if (!lookup.record) throw new Error('세션을 찾을 수 없습니다.');
  var record = lookup.record;
  var content = String(text || '').trim();
  if (!content) throw new Error('2단계 메모를 입력하세요.');
  var nowDraft = Date.now();
  record.draftText = content;
  record.draftSavedAt = nowDraft;
  if (Number(record.stage || 1) < 2) record.stage = 2;
  record.updatedAt = Date.now();
  saveWritingSession_(record, lookup.rowIndex);
  writeMemoToWorkbook_(record, '2단계 메모', content, record.draftSavedAt);
  return buildSessionStateResponse_(record);
}

function advanceToPeerStage(sessionKey) {
  var parsed = parseSessionKey_(sessionKey);
  var lookup = findWritingSessionRow_(parsed.group, parsed.studentId);
  if (!lookup.record) throw new Error('세션을 찾을 수 없습니다.');
  var record = lookup.record;
  var stage = Number(record.stage || 1);
  var group = String(record.group || '').toUpperCase();
  if (stage === 2) {
    if (!record.draftText) throw new Error('2단계 메모를 먼저 저장하세요.');
    if (group === 'C') {
      record.stage = 4;
    } else {
      record.stage = 3;
    }
  } else if (stage === 3) {
    if (!record.notesText) throw new Error('3단계 메모를 먼저 저장하세요.');
    record.stage = 4;
  } else if (stage < 2) {
    record.stage = 2;
  }
  record.updatedAt = Date.now();
  saveWritingSession_(record, lookup.rowIndex);
  return buildSessionStateResponse_(record);
}

function advanceToFinalStage(sessionKey) {
  var parsed = parseSessionKey_(sessionKey);
  var lookup = findWritingSessionRow_(parsed.group, parsed.studentId);
  if (!lookup.record) throw new Error('세션을 찾을 수 없습니다.');
  var record = lookup.record;
  var stage = Number(record.stage || 1);
  var group = String(record.group || '').toUpperCase();
  if ((group === 'A' || group === 'B') && !record.notesText) {
    throw new Error('3단계 메모를 먼저 저장하세요.');
  }
  if (group !== 'C' && stage < 3) throw new Error('최종 단계로 이동하기 전에 이전 단계를 완료하세요.');
  if (!record.draftText) throw new Error('2단계 메모를 먼저 저장하세요.');
  record.finalText = record.finalText || '';
  record.stage = 4;
  record.updatedAt = Date.now();
  saveWritingSession_(record, lookup.rowIndex);
  return buildSessionStateResponse_(record);
}

function regressStage(sessionKey) {
  var parsed = parseSessionKey_(sessionKey);
  var lookup = findWritingSessionRow_(parsed.group, parsed.studentId);
  if (!lookup.record) throw new Error('세션을 찾을 수 없습니다.');
  var record = lookup.record;
  var currentStage = Number(record.stage || 1);
  if (currentStage <= 1) {
    return buildSessionStateResponse_(record);
  }
  var group = String(record.group || '').toUpperCase();
  if (currentStage === 2) {
    record.stage = 1;
  } else if (currentStage === 3) {
    record.stage = 2;
  } else if (currentStage >= 4) {
    record.stage = (group === 'C') ? 2 : 3;
  } else {
    record.stage = Math.max(1, currentStage - 1);
  }
  record.updatedAt = Date.now();
  saveWritingSession_(record, lookup.rowIndex);
  return buildSessionStateResponse_(record);
}

function jumpToStage(sessionKey, targetStage) {
  var parsed = parseSessionKey_(sessionKey);
  var lookup = findWritingSessionRow_(parsed.group, parsed.studentId);
  if (!lookup.record) throw new Error('세션을 찾을 수 없습니다.');
  var record = lookup.record;
  var currentStage = Number(record.stage || 1);
  var desired = Number(targetStage || 0);
  if (!desired || desired < 1) desired = 1;
  desired = Math.min(4, Math.max(1, Math.floor(desired)));
  var group = String(record.group || '').toUpperCase();
  if (desired === 3 && !(group === 'A' || group === 'B')) {
    throw new Error('해당 집단은 3단계가 없습니다.');
  }
  if (desired === currentStage) {
    return buildSessionStateResponse_(record);
  }
  var movingForward = desired > currentStage;
  if (movingForward) {
    if (desired === 2 && !record.preText) {
      throw new Error('사전 글쓰기를 먼저 제출하세요.');
    }
    if (desired === 3 && !record.draftText) {
      throw new Error('2단계 메모를 먼저 저장하세요.');
    }
    if (desired === 4) {
      if (group === 'A' || group === 'B') {
        if (!record.notesText) {
          throw new Error('3단계 메모를 먼저 저장하세요.');
        }
      } else if (group === 'C') {
        if (!record.draftText) {
          throw new Error('2단계 메모를 먼저 저장하세요.');
        }
      } else {
        if (!(record.finalText || Number(record.finalSubmittedAt || 0))) {
          throw new Error('최종 단계로 이동하기 위한 조건이 충족되지 않았습니다.');
        }
      }
    }
  }
  if (desired < currentStage) {
    if (desired === 2 && !record.preText) {
      throw new Error('사전 글쓰기를 먼저 제출하세요.');
    }
    if (desired === 3 && !record.draftText) {
      throw new Error('2단계 메모를 먼저 저장하세요.');
    }
  }
  record.stage = desired;
  record.updatedAt = Date.now();
  saveWritingSession_(record, lookup.rowIndex);
  return buildSessionStateResponse_(record);
}

function savePeerNotes(sessionKey, text) {
  var parsed = parseSessionKey_(sessionKey);
  var lookup = findWritingSessionRow_(parsed.group, parsed.studentId);
  if (!lookup.record) throw new Error('세션을 찾을 수 없습니다.');
  var record = lookup.record;
  var content = String(text || '').trim();
  if (!content) throw new Error('3단계 메모를 입력하세요.');
  var nowNotes = Date.now();
  record.notesText = content;
  record.notesUpdatedAt = nowNotes;
  var group = String(record.group || '').toUpperCase();
  if (Number(record.stage || 1) < 3 && (group === 'A' || group === 'B')) {
    record.stage = 3;
  }
  record.updatedAt = Date.now();
  saveWritingSession_(record, lookup.rowIndex);
  writeMemoToWorkbook_(record, '3단계 메모', record.notesText, record.notesUpdatedAt);
  return buildSessionStateResponse_(record);
}

function submitFinalWriting(sessionKey, finalText) {
  var parsed = parseSessionKey_(sessionKey);
  var lookup = findWritingSessionRow_(parsed.group, parsed.studentId);
  if (!lookup.record) throw new Error('세션을 찾을 수 없습니다.');
  var record = lookup.record;
  var text = String(finalText || '').trim();
  if (!text) throw new Error('최종 제출할 글이 없습니다. 최종 글쓰기 입력란을 확인하세요.');
  record.finalText = text;
  record.finalSubmittedAt = Date.now();
  record.stage = 4;
  record.updatedAt = Date.now();
  saveWritingSession_(record, lookup.rowIndex);
  writeFinalWritingToWorkbook_(record);
  return buildSessionStateResponse_(record);
}

function touchPresence(sessionKey) {
  var parsed = parseSessionKey_(sessionKey);
  var lookup = findWritingSessionRow_(parsed.group, parsed.studentId);
  if (!lookup.record) return { ok: false };
  var record = lookup.record;
  if (!record.roomId) return { ok: false };
  var now = Date.now();
  writePresence_(record.roomId, record.studentId, now);
  return { ok: true, timestamp: now };
}

function getPeerSnapshot(sessionKey) {
  var parsed = parseSessionKey_(sessionKey);
  var lookup = findWritingSessionRow_(parsed.group, parsed.studentId);
  if (!lookup.record) throw new Error('세션을 찾을 수 없습니다.');
  var record = lookup.record;
  var partnerRecord = null;
  if (record.partnerStudentId) {
    var partnerLookup = findWritingSessionRow_(record.group, record.partnerStudentId);
    partnerRecord = partnerLookup.record;
  }
  var presence = buildPresenceSummary_(record.roomId, record.studentId, record.partnerStudentId);
  return {
    sessionKey: record.sessionKey,
    roomId: record.roomId,
    stage: Number(record.stage || 1),
    partner: partnerRecord ? {
      id: partnerRecord.studentId,
      name: partnerRecord.studentName,
      stage: Number(partnerRecord.stage || 1),
      prewriting: {
        text: partnerRecord.preText || '',
        submittedAt: Number(partnerRecord.preSubmittedAt || 0)
      },
      draft: {
        text: partnerRecord.draftText || '',
        savedAt: Number(partnerRecord.draftSavedAt || 0)
      },
      notes: {
        text: partnerRecord.notesText || '',
        updatedAt: Number(partnerRecord.notesUpdatedAt || 0)
      },
      final: {
        text: partnerRecord.finalText || '',
        submittedAt: Number(partnerRecord.finalSubmittedAt || 0)
      },
      presence: presence.partner || null
    } : null,
    presence: presence
  };
}

function lookupDictionary(term) {
  var query = String(term || '').trim();
  if (!query) {
    return { ok: false, message: '검색어를 입력하세요.' };
  }
  var settings = getSettings_();
  var apiKey = readUserSetting_(USERPROP_OPENAI_KEY) || settings.aiApiKey;
  if (!apiKey) {
    throw new Error('OpenAI API 키가 설정되지 않았습니다. 관리자 설정을 확인하세요.');
  }
  var hasHangul = /[\u3131-\u318E\uAC00-\uD7A3]/.test(query);
  var hasLatin = /[A-Za-z]/.test(query);
  var direction = (hasHangul && !hasLatin) ? 'ko-en' : 'en-ko';
  var sourceLanguage = direction === 'ko-en' ? 'ko' : 'en';
  var targetLanguage = direction === 'ko-en' ? 'en' : 'ko';
  var payload = JSON.stringify({
    request: 'bidirectional_dictionary_lookup',
    term: query,
    sourceLanguage: sourceLanguage,
    targetLanguage: targetLanguage
  });
  var raw = llmGenerateOpenAI_(apiKey, DICTIONARY_MODEL, DICTIONARY_SYSTEM_PROMPT, [
    { role: 'user', content: payload }
  ]);
  if (!raw) {
    return { ok: false, message: '사전 응답이 비어 있습니다.' };
  }
  var match = String(raw).match(/\{[\s\S]*\}/);
  if (!match) {
    return { ok: false, message: '사전 응답을 파싱하지 못했습니다.', raw: raw };
  }
  var jsonText = match[0];
  var data = null;
  try {
    data = JSON.parse(jsonText);
  } catch (e) {
    return { ok: false, message: '사전 JSON 파싱 오류: ' + e.message, raw: raw };
  }
  if (!data.word) data.word = query;
  data.direction = direction;
  return {
    ok: true,
    word: data.word,
    direction: direction,
    data: data,
    raw: jsonText
  };
}


