/**
 * 웹앱 엔트리 및 공통 유틸
 */

// ===== 상수/키 =====
var SETTINGS_KEY = 'SETTINGS_JSON';
var MATCHUPS_KEY = 'MATCHUPS_JSON';
var DATA_SPREADSHEET_ID_KEY = 'DATA_SPREADSHEET_ID';

var USERPROP_OPENAI_KEY = 'OPENAI_API_KEY';
var USERPROP_CONV_FOLDER_ID = 'CONV_FOLDER_ID';
var USERPROP_TEACHER_SHEET_ID = 'TEACHER_SHEET_ID';

// 기본 설정값
function getDefaultSettings_() {
  return {
    aiProvider: 'openai',
    aiApiKey: '',
    defaultModel: 'gpt-4o-mini',
    customModel: 'gpt-4o',
    aiTutorSystemPrompt: '당신은 친절한 영어 글쓰기 튜터입니다. 학생의 글을 이해하고 세심하게 피드백을 제공하세요.',
    aiAvatarUrl: '',
    // 구형 호환(남아있을 수 있음)
    customSystemPrompt: '당신은 친절하고 간결한 한국어 튜터입니다. 학생의 발화를 바탕으로 명확하고 짧게 대답하세요.',
    folderHuman: '',
    folderCustom: '',
    folderBasic: '',
    teacherSheetId: '',
    // 메인 상단 링크
    topLinkUrl: '',
    topLinkText: ''
  };
}

// ===== HTML 템플릿 =====
function include(filename) {
  var candidates = [
    'Views/' + filename,
    'Views/' + filename + '.html',
    filename,
    filename + '.html'
  ];
  for (var i = 0; i < candidates.length; i++) {
    try {
      return HtmlService.createHtmlOutputFromFile(candidates[i]).getContent();
    } catch (e) {}
  }
  throw new Error('템플릿을 찾을 수 없습니다: ' + filename);
}

function doGet(e) {
  var page = e && e.parameter && e.parameter.page;
  var tpl = (page === 'admin') ? 'admin' : 'index';
  var candidates = [
    'Views/' + tpl,
    'Views/' + tpl + '.html',
    tpl,
    tpl + '.html'
  ];
  var out = null;
  for (var i = 0; i < candidates.length; i++) {
    try {
      out = HtmlService.createTemplateFromFile(candidates[i]);
      break;
    } catch (e) {}
  }
  if (!out) throw new Error('HTML 파일을 찾을 수 없습니다: ' + tpl);
  return out.evaluate()
    .setTitle('토론/챗봇 웹앱')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function extractFileIdFromUrl_(s) {
  if (!s) return '';
  var t = String(s).trim();
  if (t.charAt(0) === '@') t = t.slice(1).trim();
  var m = t.match(/drive\.google\.com\/file\/d\/([^/]+)/);
  if (m && m[1]) return m[1];
  var m2 = t.match(/[?&]id=([^&]+)/);
  if (m2 && m2[1]) return m2[1];
  // looks like raw id?
  if (/^[a-zA-Z0-9_-]{20,}$/.test(t)) return t;
  return '';
}

function toPublicAvatarUrl_(url) {
  if (!url) return '';
  var trimmed = String(url).trim();
  if (!trimmed) return '';
  var id = extractFileIdFromUrl_(trimmed);
  if (id) return 'https://drive.google.com/uc?export=view&id=' + id;
  return trimmed;
}

// ===== 공용 유틸 =====
function generateRoomId_() {
  var rnd = Math.random().toString(36).slice(2, 8);
  var ts = Date.now().toString(36);
  return 'r_' + ts + '_' + rnd;
}

// ===== 설정/프로퍼티 =====
function getSettings_() {
  var raw = PropertiesService.getScriptProperties().getProperty(SETTINGS_KEY);
  if (!raw) return getDefaultSettings_();
  try { var obj = JSON.parse(raw); return obj || getDefaultSettings_(); } catch (e) { return getDefaultSettings_(); }
}

function saveSettings_(partial) {
  var current = getSettings_();
  Object.keys(partial || {}).forEach(function(k){ current[k] = partial[k]; });
  PropertiesService.getScriptProperties().setProperty(SETTINGS_KEY, JSON.stringify(current));
  return current;
}

function readUserSetting_(key) {
  try { return PropertiesService.getUserProperties().getProperty(key) || ''; } catch (e) { return ''; }
}

function saveUserSettings_(kv) {
  var up = PropertiesService.getUserProperties();
  Object.keys(kv || {}).forEach(function(k){ if (kv[k] != null) up.setProperty(k, String(kv[k])); });
  return true;
}

// ===== 데이터 스프레드시트 =====
function getOrCreateDataSpreadsheet_() {
  var spId = PropertiesService.getScriptProperties().getProperty(DATA_SPREADSHEET_ID_KEY);
  if (spId) {
    try { return SpreadsheetApp.openById(spId); } catch (e) {}
  }
  var ss = SpreadsheetApp.create('ChatWebApp_Data');
  PropertiesService.getScriptProperties().setProperty(DATA_SPREADSHEET_ID_KEY, ss.getId());
  var sh = ss.getSheetByName('messages') || ss.insertSheet('messages');
  if (sh.getLastRow() === 0) {
    sh.appendRow(['timestampMs','sessionId','roomId','mode','senderId','senderName','role','text','ext']);
  }
  return ss;
}

function getMessagesSheet_() {
  var ss = getOrCreateDataSpreadsheet_();
  var sh = ss.getSheetByName('messages') || ss.insertSheet('messages');
  return sh;
}

// ===== 스프레드시트 메뉴 (선택) =====
function onOpen() {
  try {
    var ui = SpreadsheetApp.getUi();
    ui.createMenu('Chatbot 설정')
      .addItem('설정 시트 생성/업데이트', 'createOrUpdateSettingsSheets_')
      .addItem('시트에서 설정 불러오기', 'loadSettingsFromSheet_')
      .addItem('설정을 시트에 내보내기', 'saveSettingsToSheet_')
      .addItem('UserProperties 입력/수정', 'promptUserProps_')
      .addSeparator()
      .addItem('관리자 페이지 열기', 'openAdminDialog_')
      .addToUi();
  } catch (e) {}
}

function createOrUpdateSettingsSheets_() {
  var ss = getOrCreateDataSpreadsheet_();
  var settingsSh = ss.getSheetByName('Settings') || ss.insertSheet('Settings');
  var matchSh = ss.getSheetByName('Matchups') || ss.insertSheet('Matchups');
  if (settingsSh.getLastRow() === 0) {
    settingsSh.appendRow(['key','value']);
    var def = getDefaultSettings_();
    Object.keys(def).forEach(function(k){ settingsSh.appendRow([k, def[k]]); });
  }
  if (matchSh.getLastRow() === 0) {
    matchSh.appendRow(['roomId','studentIdA','nameA','studentIdB','nameB']);
  }
}

function loadSettingsFromSheet_() {
  var ss = getOrCreateDataSpreadsheet_();
  var sh = ss.getSheetByName('Settings');
  if (!sh) return getSettings_();
  var rows = sh.getDataRange().getValues();
  var obj = {};
  for (var i=1; i<rows.length; i++) {
    var k = String(rows[i][0]||'').trim();
    var v = rows[i][1];
    if (k) obj[k] = v;
  }
  return saveSettings_(obj);
}

function saveSettingsToSheet_() {
  var ss = getOrCreateDataSpreadsheet_();
  var sh = ss.getSheetByName('Settings') || ss.insertSheet('Settings');
  sh.clear();
  sh.appendRow(['key','value']);
  var s = getSettings_();
  Object.keys(s).forEach(function(k){ sh.appendRow([k, s[k]]); });
}

function promptUserProps_() {
  var ui = SpreadsheetApp.getUi();
  var api = ui.prompt('OPENAI_API_KEY 입력', 'UserProperties에 저장됩니다.', ui.ButtonSet.OK_CANCEL);
  if (api.getSelectedButton() === ui.Button.OK) PropertiesService.getUserProperties().setProperty(USERPROP_OPENAI_KEY, api.getResponseText());
  var folder = ui.prompt('CONV_FOLDER_ID 입력', 'Docs 저장 폴더 ID', ui.ButtonSet.OK_CANCEL);
  if (folder.getSelectedButton() === ui.Button.OK) PropertiesService.getUserProperties().setProperty(USERPROP_CONV_FOLDER_ID, folder.getResponseText());
  var sheet = ui.prompt('TEACHER_SHEET_ID 입력', '교사 시트 ID', ui.ButtonSet.OK_CANCEL);
  if (sheet.getSelectedButton() === ui.Button.OK) PropertiesService.getUserProperties().setProperty(USERPROP_TEACHER_SHEET_ID, sheet.getResponseText());
}

/**
 * 스프레드시트에서 관리자 UI를 바로 띄우는 다이얼로그
 */
function openAdminDialog_() {
  var html = HtmlService.createTemplateFromFile('admin').evaluate();
  html.setWidth(1200).setHeight(820);
  SpreadsheetApp.getUi().showModalDialog(html, '관리자');
}

// ===== 공개: 진단 =====
function getServerDiag() {
  var sId = PropertiesService.getScriptProperties().getProperty(DATA_SPREADSHEET_ID_KEY) || '';
  var execUser = '';
  try { execUser = Session.getActiveUser().getEmail() || ''; } catch (e) {}
  return { dataSpreadsheetId: sId, scriptId: ScriptApp.getScriptId(), execUser: execUser, teacherSheetId: readUserSetting_(USERPROP_TEACHER_SHEET_ID) || getSettings_().teacherSheetId };
}

// 공개: 상단 링크용 최소 설정 반환
function getPublicSettings() {
  var s = getSettings_();
  return {
    topLinkUrl: s.topLinkUrl || '',
    topLinkText: s.topLinkText || '',
    aiAvatarUrl: toPublicAvatarUrl_(s.aiAvatarUrl || ''),
    promptContent: getPromptContent_()
  };
}

function getPromptContent_() {
  var sheetId = readUserSetting_(USERPROP_TEACHER_SHEET_ID) || getSettings_().teacherSheetId;
  if (!sheetId) return '';
  try {
    var sheet = SpreadsheetApp.openById(sheetId).getSheetByName('content');
    if (!sheet) return '';
    return String(sheet.getRange('A1').getDisplayValue() || '').trim();
  } catch (e) {
    return '';
  }
}


