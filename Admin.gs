/**
 * 관리자 API 래퍼
 */

// 간단한 비밀번호 검증 (Script Properties에 저장하거나 코드 하드코딩 대신 시트/배포 전 교체 권장)
function adminVerify(password) {
  var settings = getSettings_();
  // 보안을 위해 실제 서비스에서는 더 안전한 방법 사용
  var pass = (settings && settings.adminPassword) ? settings.adminPassword : 'admin';
  return String(password||'') === String(pass);
}

function adminGetSettings(password) {
  if (!adminVerify(password)) return null;
  return getSettings_();
}

function adminUpdateSettings(password, partial) {
  if (!adminVerify(password)) throw new Error('권한 없음');
  return saveSettings_(partial || {});
}

function adminGetMatchups(password) {
  if (!adminVerify(password)) return [];
  // 우선 UserProperties.TEACHER_SHEET_ID를 대상으로 함
  var list = [];
  var tId = readUserSetting_(USERPROP_TEACHER_SHEET_ID) || getSettings_().teacherSheetId;
  if (tId) {
    try {
      var sh = SpreadsheetApp.openById(tId).getSheetByName('Matchups');
      if (sh) list = (sh.getDataRange().getValues() || []);
    } catch (e) {}
  }
  if (!list.length) {
    try {
      var sh2 = getOrCreateDataSpreadsheet_().getSheetByName('Matchups');
      if (sh2) list = (sh2.getDataRange().getValues() || []);
    } catch (e) {}
  }
  var out = [];
  for (var i=1; i<(list||[]).length; i++) {
    var r = list[i];
    out.push({ roomId: String(r[0]||''), studentIdA: String(r[1]||''), nameA: String(r[2]||''), studentIdB: String(r[3]||''), nameB: String(r[4]||'') });
  }
  return out;
}

function adminUpsertMatchup(password, payload) {
  if (!adminVerify(password)) throw new Error('권한 없음');
  var tId = readUserSetting_(USERPROP_TEACHER_SHEET_ID) || getSettings_().teacherSheetId;
  var ss = tId ? SpreadsheetApp.openById(tId) : getOrCreateDataSpreadsheet_();
  var sh = ss.getSheetByName('Matchups') || ss.insertSheet('Matchups');
  if (sh.getLastRow() === 0) sh.appendRow(['roomId','studentIdA','nameA','studentIdB','nameB']);
  var roomId = String(payload.roomId || '').trim();
  if (!roomId) roomId = generateRoomId_();
  var found = false;
  var values = sh.getDataRange().getValues();
  for (var i=1; i<values.length; i++) {
    if (String(values[i][0]||'') === roomId) {
      sh.getRange(i+1, 1, 1, 5).setValues([[roomId, payload.studentIdA||'', payload.nameA||'', payload.studentIdB||'', payload.nameB||'']]);
      found = true; break;
    }
  }
  if (!found) sh.appendRow([roomId, payload.studentIdA||'', payload.nameA||'', payload.studentIdB||'', payload.nameB||'']);
  return adminGetMatchups(password);
}

function adminDeleteMatchup(password, roomId) {
  if (!adminVerify(password)) throw new Error('권한 없음');
  var tId = readUserSetting_(USERPROP_TEACHER_SHEET_ID) || getSettings_().teacherSheetId;
  var ss = tId ? SpreadsheetApp.openById(tId) : getOrCreateDataSpreadsheet_();
  var sh = ss.getSheetByName('Matchups') || ss.insertSheet('Matchups');
  var values = sh.getDataRange().getValues();
  var keep = [];
  for (var i=0; i<values.length; i++) {
    if (i === 0) { keep.push(values[i]); continue; }
    var r = values[i];
    if (String(r[0]||'') === String(roomId||'')) continue;
    keep.push(r);
  }
  sh.clear();
  sh.getRange(1, 1, keep.length, 5).setValues(keep);
  return adminGetMatchups(password);
}

function adminGetUserProps(password) {
  if (!adminVerify(password)) return {};
  return {
    apiKey: readUserSetting_(USERPROP_OPENAI_KEY),
    folderId: readUserSetting_(USERPROP_CONV_FOLDER_ID),
    sheetId: readUserSetting_(USERPROP_TEACHER_SHEET_ID)
  };
}

function adminSaveUserProps(password, payload) {
  if (!adminVerify(password)) throw new Error('권한 없음');
  saveUserSettings_({
    OPENAI_API_KEY: payload.apiKey || '',
    CONV_FOLDER_ID: payload.folderId || '',
    TEACHER_SHEET_ID: payload.sheetId || ''
  });
  return { ok: true };
}


