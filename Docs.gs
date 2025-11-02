/**
 * 대화내역 Google Docs 저장 및 요약 Sheet 추가
 */

function submitTranscript(sessionId, mode, participants) {
  var lock = LockService.getScriptLock();
  try { lock.tryLock(30000); } catch (e) {}

  var props = PropertiesService.getScriptProperties();
  var key = 'SUBMITTED_' + String(sessionId);
  var existed = props.getProperty(key);
  if (existed) {
    var id = props.getProperty(key + '_ID') || '';
    var url = props.getProperty(key + '_URL') || '';
    return { ok: true, already: true, docId: id, docUrl: url };
  }

  var list = getAllMessagesOfSession_(sessionId);
  var tz = Session.getScriptTimeZone() || 'Asia/Seoul';
  var timeStr = Utilities.formatDate(new Date(), tz, 'yyyy.MM.dd HH:mm');
  var who = String(participants || '').replace(/\n/g, ' ').trim();
  var title = (who ? (who + ', ') : '') + timeStr + ', ' + String(mode);
  var doc = DocumentApp.create(title);
  var body = doc.getBody();
  body.appendParagraph('세션ID: ' + sessionId);
  body.appendParagraph('모드: ' + String(mode));
  body.appendParagraph('참가자: ' + String(participants||''));
  body.appendParagraph('');
  list.forEach(function(m){
    body.appendParagraph('[' + (m.role||'') + '] ' + (m.senderName||'') + ' (' + new Date(m.ts).toLocaleString() + ')');
    body.appendParagraph(m.text||'');
    body.appendParagraph('');
  });
  doc.saveAndClose();

  // 폴더 이동
  var folderId = readUserSetting_(USERPROP_CONV_FOLDER_ID);
  if (folderId) {
    try {
      var file = DriveApp.getFileById(doc.getId());
      var dest = DriveApp.getFolderById(folderId);
      dest.addFile(file);
      var parents = file.getParents();
      while (parents.hasNext()) {
        var p = parents.next();
        if (p.getId() !== folderId) p.removeFile(file);
      }
    } catch (e) {}
  }

  // 요약 Sheet 추가 (선택) - 중복 방지: 동일 sessionId가 이미 있으면 추가하지 않음
  try {
    if (!summaryRowExists_(sessionId)) {
      var textFull = list.map(function(m){ return (m.senderName||m.role||'') + ': ' + (m.text||''); }).join('\n');
      appendSummaryRow_(new Date(), String(mode), sessionId, String(participants||''), textFull);
    }
  } catch (e) { Logger.log('Summary append failed: ' + e.message); }

  // 아이템포턴시 플래그 저장
  try {
    props.setProperty(key, '1');
    props.setProperty(key + '_ID', doc.getId());
    props.setProperty(key + '_URL', doc.getUrl());
  } catch (e) {}

  try { lock.releaseLock(); } catch (e) {}
  return { ok: true, docId: doc.getId(), docUrl: doc.getUrl() };
}

function getAllMessagesOfSession_(sessionId) {
  var sh = getMessagesSheet_();
  var lastRow = sh.getLastRow();
  if (lastRow <= 1) return [];
  var vals = sh.getRange(2, 1, lastRow - 1, 9).getValues();
  var list = [];
  for (var i=0; i<vals.length; i++) {
    var r = vals[i];
    if (String(r[1]) !== String(sessionId)) continue;
    list.push({ ts: Number(r[0]), sessionId: r[1], roomId: r[2], mode: r[3], senderId: r[4], senderName: r[5], role: r[6], text: r[7], ext: r[8] });
  }
  return list.sort(function(a,b){ return a.ts - b.ts; });
}

function appendSummaryRow_(dateObj, mode, sessionId, participantsText, fullText) {
  var sheetId = readUserSetting_(USERPROP_TEACHER_SHEET_ID) || getSettings_().teacherSheetId;
  if (!sheetId) return false;
  var ss = SpreadsheetApp.openById(sheetId);
  var sh = ss.getSheetByName('Summary') || ss.insertSheet('Summary');
  sh.appendRow([dateObj, String(mode), String(sessionId), String(participantsText||''), String(fullText||'')]);
  return true;
}

function summaryRowExists_(sessionId) {
  var sheetId = readUserSetting_(USERPROP_TEACHER_SHEET_ID) || getSettings_().teacherSheetId;
  if (!sheetId) return false;
  try {
    var ss = SpreadsheetApp.openById(sheetId);
    var sh = ss.getSheetByName('Summary');
    if (!sh) return false;
    var vals = sh.getDataRange().getValues();
    for (var i=1; i<vals.length; i++) {
      if (String(vals[i][2]||'') === String(sessionId)) return true;
    }
  } catch (e) {}
  return false;
}


