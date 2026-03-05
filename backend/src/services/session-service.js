import createError from 'http-errors';
import { v4 as uuid } from 'uuid';

const emptyWritingState = () => ({ text: '', submittedAt: 0, savedAt: 0, updatedAt: 0 });

function normalizeGroup(group) {
  const value = String(group || '').trim().toUpperCase();
  if (!['A', 'B', 'C'].includes(value)) {
    throw createError(400, '지원하지 않는 집단입니다. (A, B, C 중에서 선택)');
  }
  return value;
}

function ensureWriting(session) {
  session.writing = session.writing || {};
  session.writing.prewriting = session.writing.prewriting || { ...emptyWritingState() };
  session.writing.draft = session.writing.draft || { ...emptyWritingState() };
  session.writing.notes = session.writing.notes || { ...emptyWritingState() };
  session.writing.final = session.writing.final || { ...emptyWritingState() };
}

function ensureSteps(session) {
  session.steps = session.steps || {};
  session.steps.prewriting = session.steps.prewriting || { completed: false, submittedAt: 0 };
  session.steps.draft = session.steps.draft || { saved: false, savedAt: 0 };
  session.steps.notes = session.steps.notes || { saved: false, updatedAt: 0 };
  session.steps.final = session.steps.final || { submitted: false, submittedAt: 0 };
}

function getPreviousStage(session) {
  const current = Number(session.stage || 1);
  const group = normalizeGroup(session.mode || 'A');
  if (current <= 1) return 1;
  if (current === 2) return 1;
  if (current === 3) return 2;
  if (current >= 4) return group === 'C' ? 2 : 3;
  return Math.max(1, current - 1);
}

function advanceStageValue(session, target) {
  const current = Number(session.stage || 1);
  if (target > current) {
    session.stage = target;
  }
  return session.stage;
}

function computeNextStageForAdvance(session) {
  const group = session.mode ? normalizeGroup(session.mode) : 'A';
  const current = Number(session.stage || 1);
  if (current >= 4) return 4;
  if (group === 'C') return 4;
  if (current <= 2) return 3;
  return Math.min(4, current + 1);
}

const DEFAULT_TIMER_DURATIONS = {
  stage1PrewritingMinutes: 20,
  stage2AiFeedbackMinutes: 20,
  stage3PeerReviewMinutes: 10,
  stage3PeerRevisionMinutes: 15,
  stage4FinalRevisionMinutes: 20
};

function toPositiveInt(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.round(num);
}

function normalizeTimer(timer = {}) {
  const durations = timer?.durations || {};
  return {
    running: Boolean(timer.running),
    startedAt: Number(timer.startedAt || 0),
    updatedAt: Number(timer.updatedAt || 0),
    durations: {
      stage1PrewritingMinutes: toPositiveInt(
        durations.stage1PrewritingMinutes,
        DEFAULT_TIMER_DURATIONS.stage1PrewritingMinutes
      ),
      stage2AiFeedbackMinutes: toPositiveInt(
        durations.stage2AiFeedbackMinutes,
        DEFAULT_TIMER_DURATIONS.stage2AiFeedbackMinutes
      ),
      stage3PeerReviewMinutes: toPositiveInt(
        durations.stage3PeerReviewMinutes,
        DEFAULT_TIMER_DURATIONS.stage3PeerReviewMinutes
      ),
      stage3PeerRevisionMinutes: toPositiveInt(
        durations.stage3PeerRevisionMinutes,
        DEFAULT_TIMER_DURATIONS.stage3PeerRevisionMinutes
      ),
      stage4FinalRevisionMinutes: toPositiveInt(
        durations.stage4FinalRevisionMinutes,
        DEFAULT_TIMER_DURATIONS.stage4FinalRevisionMinutes
      )
    }
  };
}

function buildTimerPhases(timer) {
  const d = timer.durations;
  return [
    { key: 'stage1', label: 'Stage 1 Prewriting', seconds: d.stage1PrewritingMinutes * 60 },
    { key: 'stage2', label: 'Stage 2 AI Feedback', seconds: d.stage2AiFeedbackMinutes * 60 },
    { key: 'stage3-review', label: 'Stage 3 Peer Reading', seconds: d.stage3PeerReviewMinutes * 60 },
    { key: 'stage3-revise', label: 'Stage 3 Peer Revision', seconds: d.stage3PeerRevisionMinutes * 60 },
    { key: 'stage4', label: 'Stage 4 Final Revision', seconds: d.stage4FinalRevisionMinutes * 60 }
  ];
}

export function createSessionService(dataStore) {
  if (!dataStore) throw new Error('dataStore가 필요합니다.');

  let rosterCache = null;
  let rosterPairingsCache = [];
  let rosterFetchedAt = 0;
  const ROSTER_CACHE_TTL = 60 * 1000;
  let timerCache = null;
  let timerFetchedAt = 0;
  const TIMER_CACHE_TTL = 1000;

  async function getTimer(forceReload = false) {
    const now = Date.now();
    if (!forceReload && timerCache && now - timerFetchedAt < TIMER_CACHE_TTL) {
      return timerCache;
    }
    const stored = typeof dataStore.getTimer === 'function' ? await dataStore.getTimer() : {};
    timerCache = normalizeTimer(stored || {});
    timerFetchedAt = now;
    return timerCache;
  }

  function buildTimerSnapshot(timer, mode = 'A') {
    const normalized = normalizeTimer(timer);
    const phases = buildTimerPhases(normalized);
    const now = Date.now();
    const elapsedSeconds = normalized.running && normalized.startedAt
      ? Math.max(0, Math.floor((now - normalized.startedAt) / 1000))
      : 0;

    let acc = 0;
    let currentPhase = null;
    for (let i = 0; i < phases.length; i += 1) {
      const phase = phases[i];
      const startOffsetSeconds = acc;
      const endOffsetSeconds = acc + phase.seconds;
      if (elapsedSeconds < endOffsetSeconds) {
        currentPhase = {
          ...phase,
          index: i + 1,
          startOffsetSeconds,
          endOffsetSeconds,
          elapsedSeconds: Math.max(0, elapsedSeconds - startOffsetSeconds),
          remainingSeconds: Math.max(0, endOffsetSeconds - elapsedSeconds)
        };
        break;
      }
      acc = endOffsetSeconds;
    }

    const t1 = normalized.durations.stage1PrewritingMinutes * 60;
    const t2 = normalized.durations.stage2AiFeedbackMinutes * 60;
    const t3 = normalized.durations.stage3PeerReviewMinutes * 60;
    const t4 = normalized.durations.stage3PeerRevisionMinutes * 60;
    let unlockedStage = 1;
    if (normalized.running && normalized.startedAt) {
      if (elapsedSeconds >= t1) unlockedStage = 2;
      if (elapsedSeconds >= t1 + t2) unlockedStage = 3;
      if (normalizeGroup(mode || 'A') === 'C') {
        if (elapsedSeconds >= t1 + t2) unlockedStage = 4;
      } else if (elapsedSeconds >= t1 + t2 + t3 + t4) {
        unlockedStage = 4;
      }
    }

    return {
      running: normalized.running,
      startedAt: normalized.startedAt,
      updatedAt: normalized.updatedAt,
      durations: normalized.durations,
      elapsedSeconds,
      unlockedStage,
      phases,
      currentPhase
    };
  }

  function requiredElapsedSecondsForTargetStage(session, targetStage, timer) {
    const d = timer.durations;
    const t1 = d.stage1PrewritingMinutes * 60;
    const t2 = d.stage2AiFeedbackMinutes * 60;
    const t3 = d.stage3PeerReviewMinutes * 60;
    const t4 = d.stage3PeerRevisionMinutes * 60;
    if (targetStage <= 1) return 0;
    if (targetStage === 2) return t1;
    if (targetStage === 3) return t1 + t2;
    if (targetStage >= 4) {
      const group = normalizeGroup(session.mode || 'A');
      if (group === 'C') return t1 + t2;
      return t1 + t2 + t3 + t4;
    }
    return 0;
  }

  function formatRemaining(seconds) {
    const remain = Math.max(0, Number(seconds || 0));
    const min = Math.floor(remain / 60);
    const sec = remain % 60;
    return `${min}m ${String(sec).padStart(2, '0')}s`;
  }

  async function ensureTimerAllowsStageChange(session, targetStage) {
    const current = Number(session.stage || 1);
    const desired = Number(targetStage || current);
    if (desired <= current) return;

    const timer = await getTimer();
    if (!timer.running || !timer.startedAt) {
      throw createError(409, '관리자가 타이머를 시작하기 전에는 다음 단계로 이동할 수 없습니다.');
    }
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - Number(timer.startedAt || 0)) / 1000));
    const requiredSeconds = requiredElapsedSecondsForTargetStage(session, desired, timer);
    if (elapsedSeconds < requiredSeconds) {
      throw createError(
        409,
        `아직 단계 이동 시간이 되지 않았습니다. 남은 시간: ${formatRemaining(requiredSeconds - elapsedSeconds)}`
      );
    }
  }

  async function attachTimer(session) {
    if (!session) return session;
    const timer = await getTimer();
    return {
      ...session,
      timer: buildTimerSnapshot(timer, session.mode || 'A')
    };
  }

  function normalizeId(value) {
    return String(value || '').trim();
  }

  function normalizeIdForCompare(value) {
    return normalizeId(value).toLowerCase();
  }

  function normalizeName(value) {
    return String(value || '').trim();
  }

  function buildFallbackPairings(students = []) {
    const buckets = new Map();
    (Array.isArray(students) ? students : []).forEach((student) => {
      if (!student) return;
      const id = normalizeId(student.id);
      if (!id) return;
      const name = normalizeName(student.name);
      const groupKey = id.charAt(0).toUpperCase();
      if (!buckets.has(groupKey)) buckets.set(groupKey, []);
      buckets.get(groupKey).push({ id, name });
    });
    const seen = new Set();
    const fallback = [];
    for (const list of buckets.values()) {
      for (let i = 0; i + 1 < list.length; i += 2) {
        const first = list[i];
        const second = list[i + 1];
        const primaryKey = normalizeIdForCompare(first.id);
        const partnerKey = normalizeIdForCompare(second.id);
        if (!primaryKey || !partnerKey || primaryKey === partnerKey) continue;
        const dedupeKey = [primaryKey, partnerKey].sort().join('|');
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        fallback.push({
          primary: { id: first.id, name: first.name },
          partner: { id: second.id, name: second.name }
        });
      }
    }
    return fallback;
  }

  function normalizeRosterPairingsForCache(pairings = [], students = []) {
    const list = Array.isArray(pairings) ? pairings : [];
    const seen = new Set();
    const studentNameMap = new Map(
      (Array.isArray(students) ? students : []).map((student) => [normalizeIdForCompare(student.id), normalizeName(student.name)])
    );
    const normalized = [];
    for (const entry of list) {
      if (!entry) continue;
      const primaryId = normalizeId(entry.primary?.id);
      const partnerId = normalizeId(entry.partner?.id);
      if (!primaryId || !partnerId) continue;
      const primaryKey = normalizeIdForCompare(primaryId);
      const partnerKey = normalizeIdForCompare(partnerId);
      if (primaryKey === partnerKey) continue;
      const key = [primaryKey, partnerKey].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push({
        primary: {
          id: primaryId,
          name: normalizeName(entry.primary?.name || studentNameMap.get(primaryKey) || '')
        },
        partner: {
          id: partnerId,
          name: normalizeName(entry.partner?.name || studentNameMap.get(partnerKey) || '')
        }
      });
    }
    if (!normalized.length) {
      const fallback = buildFallbackPairings(students);
      fallback.forEach((pair) => {
        const primaryKey = normalizeIdForCompare(pair.primary?.id);
        const partnerKey = normalizeIdForCompare(pair.partner?.id);
        if (!primaryKey || !partnerKey || primaryKey === partnerKey) return;
        const key = [primaryKey, partnerKey].sort().join('|');
        if (seen.has(key)) return;
        seen.add(key);
        normalized.push(pair);
      });
    }
    return normalized;
  }

  async function fetchRosterStudents(forceReload = false) {
    if (!dataStore.getRoster) {
      throw createError(500, '학생 명단 기능이 활성화되지 않았습니다.');
    }
    const now = Date.now();
    if (!forceReload && rosterCache && now - rosterFetchedAt < ROSTER_CACHE_TTL) {
      console.log('[fetchRosterStudents] 캐시 사용, 학생 수', rosterCache.length, '매칭 수', rosterPairingsCache.length);
      return rosterCache;
    }
    const roster = await dataStore.getRoster();
    const students = Array.isArray(roster?.students) ? roster.students : [];
    rosterCache = students.map((item) => ({
      id: normalizeId(item.id),
      name: normalizeName(item.name)
    }));
    rosterPairingsCache = normalizeRosterPairingsForCache(roster?.pairings || [], rosterCache);
    rosterFetchedAt = now;
    console.log('[fetchRosterStudents] 로스터 새로 로드, 학생 수', rosterCache.length, '매칭 수', rosterPairingsCache.length);
    console.log('[fetchRosterStudents] 매칭 목록:', rosterPairingsCache.map(p => `${p.primary.id}-${p.partner.id}`));
    return rosterCache;
  }

  function findRosterPairingForStudent(studentId) {
    const target = normalizeIdForCompare(studentId);
    if (!target) return null;
    return (
      rosterPairingsCache.find(
        (pair) => normalizeIdForCompare(pair.primary?.id) === target || normalizeIdForCompare(pair.partner?.id) === target
      ) || null
    );
  }

  function resolvePartnerEntry(pair, studentId) {
    const target = normalizeIdForCompare(studentId);
    if (normalizeIdForCompare(pair.primary?.id) === target) return pair.partner;
    return pair.primary;
  }

  function buildPartnerSnapshot(session, fallback = {}, includeDetails = false) {
    const snapshot = {
      sessionKey: session?.sessionKey || '',
      id: normalizeId(fallback.id || session?.you?.id),
      name: normalizeName(session?.you?.name || fallback.name)
    };
    if (includeDetails && session) {
      ensureWriting(session);
      snapshot.stage = Number(session.stage || 1);
      const prewriting = session.writing?.prewriting || session.prewriting;
      const draft = session.writing?.draft || session.draft;
      const notes = session.writing?.notes || session.notes;
      if (prewriting) {
        snapshot.prewriting = {
          text: String(prewriting.text || ''),
          submittedAt: Number(prewriting.submittedAt || 0)
        };
      }
      if (draft) {
        snapshot.draft = {
          text: String(draft.text || ''),
          savedAt: Number(draft.savedAt || draft.updatedAt || 0)
        };
      }
      if (notes) {
        snapshot.notes = {
          text: String(notes.text || ''),
          updatedAt: Number(notes.updatedAt || notes.savedAt || 0)
        };
      }
    }
    return snapshot;
  }

  function buildPartnerPresence(session, fallback = {}) {
    return {
      sessionKey: session?.sessionKey || '',
      name: normalizeName(session?.you?.name || fallback.name),
      id: normalizeId(session?.you?.id || fallback.id),
      stage: Number(session?.stage || fallback.stage || 1),
      online: session?.presence?.self?.online ?? Boolean(fallback.online),
      lastSeen: Number(session?.presence?.self?.lastSeen || fallback.lastSeen || 0)
    };
  }

  function rememberRosterPairing(primary, partner) {
    if (!primary || !partner) return;
    const primaryId = normalizeId(primary.id);
    const partnerId = normalizeId(partner.id);
    if (!primaryId || !partnerId) return;
    const primaryKey = normalizeIdForCompare(primaryId);
    const partnerKey = normalizeIdForCompare(partnerId);
    if (!primaryKey || !partnerKey || primaryKey === partnerKey) return;
    const dedupeKey = [primaryKey, partnerKey].sort().join('|');
    if (rosterPairingsCache.some((entry) => {
      const entryKey = [normalizeIdForCompare(entry.primary?.id || ''), normalizeIdForCompare(entry.partner?.id || '')]
        .sort()
        .join('|');
      return entryKey === dedupeKey;
    })) {
      return;
    }
    rosterPairingsCache.push({
      primary: {
        id: primaryId,
        name: normalizeName(primary.name)
      },
      partner: {
        id: partnerId,
        name: normalizeName(partner.name)
      }
    });
  }

  function deriveGroupFromStudentId(studentId) {
    const first = String(studentId || '').trim().charAt(0).toUpperCase();
    if (['A', 'B', 'C'].includes(first)) {
      return first;
    }
    return 'A';
  }

  function buildSeedSessionRecord(student, partner, peerSessionId) {
    const now = Date.now();
    const sessionKey = uuid();
    const aiSessionId = uuid();
    const group = deriveGroupFromStudentId(student.id);

    return {
      sessionKey,
      mode: group,
      createdAt: now,
      updatedAt: now,
      stage: 1,
      you: {
        id: normalizeId(student.id),
        name: normalizeName(student.name)
      },
      writing: {
        prewriting: { ...emptyWritingState() },
        draft: { ...emptyWritingState() },
        notes: { ...emptyWritingState() },
        final: { ...emptyWritingState() }
      },
      steps: {
        prewriting: { completed: false, submittedAt: 0 },
        draft: { saved: false, savedAt: 0 },
        notes: { saved: false, updatedAt: 0 },
        final: { submitted: false, submittedAt: 0 }
      },
      partner: partner
        ? {
            sessionKey: '',
            id: normalizeId(partner.id),
            name: normalizeName(partner.name)
          }
        : null,
      presence: {
        self: {
          online: false,
          lastSeen: 0,
          stage: 1,
          id: normalizeId(student.id),
          name: normalizeName(student.name)
        },
        partner: partner
          ? {
              sessionKey: '',
              id: normalizeId(partner.id),
              name: normalizeName(partner.name),
              stage: 1,
              online: false,
              lastSeen: 0
            }
          : null
      },
      aiSessionId,
      peerSessionId: peerSessionId || uuid()
    };
  }

  async function ensureSeedSession(student, partner, peerSessionId, existingSession = null) {
    const studentId = normalizeId(student?.id);
    if (!studentId) return null;
    const normalizedPartner = partner
      ? {
          id: normalizeId(partner.id),
          name: normalizeName(partner.name)
        }
      : null;

    const existing = existingSession || (await findExistingSessionByStudentId(studentId));
    if (existing) {
      let mutated = existing;
      const existingPartnerId = normalizeIdForCompare(existing?.partner?.id || '');
      const desiredPartnerId = normalizeIdForCompare(normalizedPartner?.id || '');
      const needsPartner = normalizedPartner && existingPartnerId !== desiredPartnerId;
      const needsPeerId = normalizedPartner && peerSessionId && existing.peerSessionId !== peerSessionId;

      if (needsPartner || needsPeerId) {
        mutated = await dataStore.updateSession(existing.sessionKey, (record) => {
          ensureWriting(record);
          ensureSteps(record);
          if (normalizedPartner) {
            record.partner = {
              sessionKey: '',
              id: normalizedPartner.id,
              name: normalizedPartner.name
            };
            record.presence = record.presence || {};
            record.presence.partner = {
              sessionKey: '',
              id: normalizedPartner.id,
              name: normalizedPartner.name,
              stage: Number(record.presence?.partner?.stage || 1),
              online:
                normalizeIdForCompare(record.presence?.partner?.id || '') === desiredPartnerId
                  ? Boolean(record.presence?.partner?.online)
                  : false,
              lastSeen: Number(record.presence?.partner?.lastSeen || 0)
            };
          }
          if (peerSessionId) {
            record.peerSessionId = peerSessionId;
          }
          return record;
        });
      }
      return mutated;
    }

    const base = buildSeedSessionRecord({ id: studentId, name: student.name }, normalizedPartner, peerSessionId);
    const saved = await dataStore.saveSession(base.sessionKey, base);
    return saved;
  }

  async function seedSessionForPair(primary, partner) {
    if (!primary?.id || !partner?.id) return null;
    const primaryExisting = await findExistingSessionByStudentId(primary.id);
    const partnerExisting = await findExistingSessionByStudentId(partner.id);
    const sharedPeerId = primaryExisting?.peerSessionId || partnerExisting?.peerSessionId || uuid();

    const primarySession = await ensureSeedSession(primary, partner, sharedPeerId, primaryExisting);
    const partnerSession = await ensureSeedSession(partner, primary, sharedPeerId, partnerExisting);

    return {
      primarySessionKey: primarySession?.sessionKey || primaryExisting?.sessionKey || null,
      partnerSessionKey: partnerSession?.sessionKey || partnerExisting?.sessionKey || null,
      peerSessionId: sharedPeerId
    };
  }

  async function seedRosterSessions({ forceReload = false } = {}) {
    await fetchRosterStudents(forceReload);
    const results = [];

    for (const pair of rosterPairingsCache) {
      const primary = pair?.primary || null;
      const partner = pair?.partner || null;
      if (!primary?.id || !partner?.id) continue;
      const outcome = await seedSessionForPair(primary, partner);
      if (outcome) {
        results.push(outcome);
      }
    }

    return {
      processed: results.length,
      peerSessionIds: results.map((item) => item.peerSessionId).filter(Boolean)
    };
  }

  async function updatePartnerMirrorPresence(session) {
    if (!session?.partner) return;
    const partnerInfo = session.partner;
    let partnerSession = null;
    if (partnerInfo.sessionKey) {
      try {
        partnerSession = await dataStore.getSession(partnerInfo.sessionKey);
      } catch (error) {
        partnerSession = null;
      }
    }
    if (!partnerSession && partnerInfo.id) {
      partnerSession = await findExistingSessionByStudentId(partnerInfo.id);
    }
    if (!partnerSession || partnerSession.sessionKey === session.sessionKey) return;
    await dataStore.updateSession(partnerSession.sessionKey, (record) => {
      record.presence = record.presence || {};
      record.presence.partner = buildPartnerPresence(session, {
        id: session.you?.id,
        name: session.you?.name
      });
      return record;
    });
  }

  async function determineSharedPeerSessionId(session, partnerSession) {
    const sessionPeerId = String(session?.peerSessionId || '').trim();
    const partnerPeerId = String(partnerSession?.peerSessionId || '').trim();
    let sharedId = sessionPeerId || partnerPeerId || uuid();
    let messagesA = [];
    let messagesB = [];
    if (sessionPeerId) {
      try {
        messagesA = await dataStore.getChatHistory(sessionPeerId, 'peer');
      } catch (error) {
        messagesA = [];
      }
    }
    if (partnerPeerId) {
      try {
        messagesB = await dataStore.getChatHistory(partnerPeerId, 'peer');
      } catch (error) {
        messagesB = [];
      }
    }
    if (sessionPeerId && partnerPeerId && sessionPeerId !== partnerPeerId) {
      if (messagesA.length && !messagesB.length) {
        sharedId = sessionPeerId;
      } else if (!messagesA.length && messagesB.length) {
        sharedId = partnerPeerId;
      } else if (!messagesA.length && !messagesB.length) {
        sharedId = sessionPeerId || partnerPeerId || uuid();
      } else {
        sharedId = uuid();
      }
    }
    if (!sharedId) sharedId = uuid();
    const mergeSources = [];
    const addSource = (id, messages) => {
      if (!id || id === sharedId || !Array.isArray(messages) || !messages.length) return;
      if (mergeSources.some((src) => src.id === id)) return;
      mergeSources.push({ id, messages });
    };
    if (sessionPeerId && sessionPeerId !== sharedId) addSource(sessionPeerId, messagesA);
    if (partnerPeerId && partnerPeerId !== sharedId) addSource(partnerPeerId, messagesB);
    
    console.log('[determineSharedPeerSessionId] 결과:', {
      sessionPeerId,
      partnerPeerId,
      sharedId,
      mergeSources: mergeSources.map(s => ({ id: s.id, count: s.messages.length }))
    });
    
    return { sharedId, mergeSources };
  }

  async function mergePeerChatHistories(targetId, sources = []) {
    const target = String(targetId || '').trim();
    if (!target || !Array.isArray(sources) || !sources.length) return;
    let existing = [];
    try {
      existing = await dataStore.getChatHistory(target, 'peer');
    } catch (error) {
      existing = [];
    }
    const seen = new Set(existing.map((msg) => `${Number(msg.ts || 0)}|${msg.senderId || ''}|${msg.text || ''}`));
    for (const source of sources) {
      if (!source || !Array.isArray(source.messages) || !source.messages.length) continue;
      const sorted = [...source.messages].sort((a, b) => Number(a?.ts || 0) - Number(b?.ts || 0));
      for (const message of sorted) {
        if (!message) continue;
        const key = `${Number(message.ts || 0)}|${message.senderId || ''}|${message.text || ''}`;
        if (seen.has(key)) continue;
        await dataStore.appendChatMessage(target, 'peer', message);
        seen.add(key);
      }
    }
  }

  async function findExistingSessionByStudentId(studentId) {
    const target = normalizeIdForCompare(studentId);
    if (!target) return null;
    console.log('[findExistingSessionByStudentId] 검색 대상', studentId, '-> ', target);
    
    const keys = await dataStore.listSessions();
    console.log('[findExistingSessionByStudentId] 전체 세션 수', keys?.length || 0);
    
    if (!keys?.length) return null;
    
    let candidate = null;
    for (const key of keys) {
      try {
        const session = await dataStore.getSession(key);
        if (!session?.you?.id) continue;
        
        const sessionUserId = normalizeIdForCompare(session.you.id);
        console.log('[findExistingSessionByStudentId] 세션 비교', key, session.you.id, '-> ', sessionUserId);
        
        if (sessionUserId !== target) continue;
        
        if (!candidate) {
          candidate = session;
          console.log('[findExistingSessionByStudentId] 첫 번째 매칭 세션:', key);
          continue;
        }
        const candidateUpdated = Number(candidate.updatedAt || candidate.createdAt || 0);
        const sessionUpdated = Number(session.updatedAt || session.createdAt || 0);
        if (sessionUpdated > candidateUpdated) {
          candidate = session;
          console.log('[findExistingSessionByStudentId] 더 최신 세션으로 교체:', key);
        }
      } catch (error) {
        console.warn('기존 세션 조회 실패', error);
      }
    }
    console.log('[findExistingSessionByStudentId] 최종 결과:', candidate ? candidate.sessionKey : 'null');
    return candidate;
  }

  async function ensureStudentAllowed(studentId, studentName) {
    const id = normalizeId(studentId);
    const name = normalizeName(studentName);
    if (!id) {
      throw createError(400, '학번 번호를 입력하세요.');
    }
    if (!name) {
      throw createError(400, '이름을 입력하세요.');
    }
    const roster = await fetchRosterStudents();
    if (!roster.length) {
      throw createError(403, '학생 명단이 비어 있습니다. 관리자에게 문의하세요.');
    }
    const matched = roster.find((student) => normalizeIdForCompare(student.id) === normalizeIdForCompare(id));
    if (!matched) {
      throw createError(403, '등록되지 않은 학번 번호입니다. 관리자에게 문의하세요.');
    }
    if (matched.name && normalizeName(matched.name) && normalizeName(matched.name) !== name) {
      throw createError(403, '등록된 이름과 일치하지 않습니다. 관리자에게 문의하세요.');
    }
    return {
      id: matched.id || id,
      name: matched.name || name
    };
  }

  async function ensurePartnerAllowed(partnerSessionKey, partnerId, partnerName) {
    if (partnerSessionKey) {
      return null;
    }
    const id = normalizeId(partnerId);
    const name = normalizeName(partnerName);
    if (!id) {
      throw createError(400, '동료 학번 번호를 입력하세요.');
    }
    const roster = await fetchRosterStudents();
    const matched = roster.find((student) => normalizeIdForCompare(student.id) === normalizeIdForCompare(id));
    if (!matched) {
      throw createError(404, '등록되지 않은 동료 학번 번호입니다.');
    }
    if (matched.name && name && normalizeName(matched.name) !== name) {
      throw createError(403, '동료 이름이 등록된 정보와 일치하지 않습니다.');
    }
    return {
      id: matched.id || id,
      name: matched.name || name
    };
  }

  async function startSession({ group, studentId, studentName }) {
    const normalizedGroup = normalizeGroup(group);
    const verifiedStudent = await ensureStudentAllowed(studentId, studentName);
    
    // 로그인 시 로스터 강제 갱신
    await fetchRosterStudents(true);
    const existingSession = await findExistingSessionByStudentId(verifiedStudent.id);
    if (existingSession) {
      const updated = await dataStore.updateSession(existingSession.sessionKey, (session) => {
        ensureWriting(session);
        ensureSteps(session);
        const now = Date.now();
        session.mode = session.mode || normalizedGroup;
        session.you = {
          id: verifiedStudent.id,
          name: verifiedStudent.name
        };
        session.presence = session.presence || {};
        session.presence.self = {
          ...(session.presence.self || {}),
          online: true,
          lastSeen: now,
          stage: session.stage || 1,
          name: verifiedStudent.name,
          id: verifiedStudent.id
        };
        if (!session.aiSessionId) session.aiSessionId = existingSession.aiSessionId || uuid();
        if (!session.peerSessionId) session.peerSessionId = existingSession.peerSessionId || uuid();
        if (!session.createdAt) session.createdAt = existingSession.createdAt || now;
        return session;
      });
      const paired = await ensureRosterPairing(updated);
      return attachTimer(paired);
    }
    const now = Date.now();
    const sessionKey = uuid();
    const aiSessionId = uuid();
    const peerSessionId = uuid();
    const base = {
      sessionKey,
      createdAt: now,
      mode: normalizedGroup,
      you: { id: verifiedStudent.id, name: verifiedStudent.name },
      stage: 1,
      updatedAt: now,
      writing: {
        prewriting: { text: '', submittedAt: 0 },
        draft: { text: '', savedAt: 0 },
        notes: { text: '', updatedAt: 0 },
        final: { text: '', submittedAt: 0 }
      },
      steps: {
        prewriting: { completed: false, submittedAt: 0 },
        draft: { saved: false, savedAt: 0 },
        notes: { saved: false, updatedAt: 0 },
        final: { submitted: false, submittedAt: 0 }
      },
      partner: null,
      presence: {
        self: { online: true, lastSeen: now, stage: 1 },
        partner: null
      },
      aiSessionId,
      peerSessionId
    };
    const saved = await dataStore.saveSession(sessionKey, base);
    const paired = await ensureRosterPairing(saved);
    return attachTimer(paired);
  }

  async function ensureRosterPairing(session) {
    if (!session || !session.sessionKey || !session.you?.id) {
      return session;
    }
    console.log('[ensureRosterPairing] 세션 확인:', {
      sessionKey: session.sessionKey,
      userId: session.you?.id,
      currentPartner: session.partner?.id,
      currentPeerSessionId: session.peerSessionId
    });
    
    const pair = findRosterPairingForStudent(session.you.id);
    if (!pair) {
      console.log('[ensureRosterPairing] 로스터에서 매칭을 찾지 못함:', session.you.id);
      return session;
    }
    const partnerEntry = resolvePartnerEntry(pair, session.you.id) || {};
    const desiredPartnerId = normalizeId(partnerEntry.id);
    if (!desiredPartnerId) return session;
    const desiredPartnerKey = normalizeIdForCompare(desiredPartnerId);
    const currentPartnerKey = session.partner?.id ? normalizeIdForCompare(session.partner.id) : '';
    const selfKey = normalizeIdForCompare(session.you.id);

    if (currentPartnerKey && currentPartnerKey !== desiredPartnerKey) {
      return session;
    }

    console.log('[ensureRosterPairing] 매칭 찾음:', {
      partnerEntry: partnerEntry,
      desiredPartnerId: desiredPartnerId,
      selfKey: selfKey
    });
    
    const partnerSession = await findExistingSessionByStudentId(desiredPartnerId);
    console.log('[ensureRosterPairing] 동료 세션 검색 결과:', partnerSession ? partnerSession.sessionKey : 'null');
    
    if (!partnerSession) {
      if (!currentPartnerKey) {
        return dataStore.updateSession(session.sessionKey, (record) => {
          ensureWriting(record);
          ensureSteps(record);
          rememberRosterPairing({ id: session.you?.id, name: session.you?.name }, partnerEntry);
          record.partner = {
            sessionKey: '',
            name: normalizeName(partnerEntry.name),
            id: desiredPartnerId
          };
          record.presence = record.presence || {};
          record.presence.partner = {
            ...(record.presence.partner || {}),
            sessionKey: '',
            name: normalizeName(partnerEntry.name),
            id: desiredPartnerId,
            stage: 1,
            online: false,
            lastSeen: 0
          };
          return record;
        });
      }
      return session;
    }
    const partnerCurrentKey = partnerSession.partner?.id ? normalizeIdForCompare(partnerSession.partner.id) : '';
    if (partnerCurrentKey && partnerCurrentKey !== selfKey) {
      return session;
    }

    const { sharedId, mergeSources } = await determineSharedPeerSessionId(session, partnerSession);
    console.log('[ensureRosterPairing] 공유 peerSessionId:', sharedId);
    
    const partnerSnapshot = buildPartnerSnapshot(partnerSession, partnerEntry);
    const partnerPresence = buildPartnerPresence(partnerSession, partnerEntry);
    const selfSnapshot = buildPartnerSnapshot(session, { id: session.you.id, name: session.you.name });
    const selfPresence = buildPartnerPresence(session, { id: session.you.id, name: session.you.name });

    const [updatedSession, updatedPartner] = await Promise.all([
      dataStore.updateSession(session.sessionKey, (record) => {
        ensureWriting(record);
        ensureSteps(record);
        rememberRosterPairing(session.you || { id: session.you?.id, name: session.you?.name }, partnerEntry);
        record.partner = buildPartnerSnapshot(partnerSession, partnerEntry, true);
        record.presence = record.presence || {};
        record.presence.partner = partnerPresence;
        record.peerSessionId = sharedId;
        return record;
      }),
      dataStore.updateSession(partnerSession.sessionKey, (record) => {
        ensureWriting(record);
        ensureSteps(record);
        record.partner = buildPartnerSnapshot(session, { id: session.you?.id, name: session.you?.name }, true);
        record.presence = record.presence || {};
        record.presence.partner = selfPresence;
        record.peerSessionId = sharedId;
        return record;
      })
    ]);
    if (mergeSources.length) {
      await mergePeerChatHistories(sharedId, mergeSources);
    }
    await Promise.all([updatePartnerMirrorPresence(updatedSession), updatePartnerMirrorPresence(updatedPartner)]);
    return updatedSession;
  }

  async function getSessionState(sessionKey) {
    const session = await dataStore.getSession(sessionKey);
    if (!session) {
      throw createError(404, '세션을 찾을 수 없습니다.');
    }
    const updated = await ensureRosterPairing(session);
    if (updated?.partner?.sessionKey) {
      try {
        const partnerSession = await dataStore.getSession(updated.partner.sessionKey);
        if (partnerSession) {
          await ensureRosterPairing(partnerSession);
        }
      } catch (error) {
        console.warn('동료 세션 동기화 실패', error);
      }
    }
    return attachTimer(updated);
  }

  async function listSessions() {
    const keys = await dataStore.listSessions();
    if (!keys.length) return [];
    const sessions = await Promise.all(keys.map((key) => dataStore.getSession(key)));
    return sessions
      .filter(Boolean)
      .map((session) => ({
        sessionKey: session.sessionKey,
        group: session.mode,
        user: session.you,
        stage: session.stage,
        createdAt: Number(session.createdAt || session.updatedAt || 0),
        updatedAt: Number(session.updatedAt || 0),
        writing: {
          prewritingSubmittedAt: Number(session.writing?.prewriting?.submittedAt || 0),
          draftSavedAt: Number(session.writing?.draft?.savedAt || 0),
          notesUpdatedAt: Number(session.writing?.notes?.updatedAt || 0),
          finalSubmittedAt: Number(session.writing?.final?.submittedAt || 0)
        },
        partner: session.partner || null
      }));
  }

  async function submitPrewriting(sessionKey, text) {
    const cleaned = String(text || '').trim();
    if (!cleaned) throw createError(400, '사전 글쓰기를 입력해주세요.');
    let canAdvanceToStage2 = false;
    const current = await dataStore.getSession(sessionKey);
    if (current && Number(current.stage || 1) >= 2) {
      canAdvanceToStage2 = true;
    } else if (current) {
      try {
        await ensureTimerAllowsStageChange(current, 2);
        canAdvanceToStage2 = true;
      } catch (error) {
        canAdvanceToStage2 = false;
      }
    }
    const updated = await dataStore.updateSession(sessionKey, (session) => {
      ensureWriting(session);
      ensureSteps(session);
      const submittedAt = Date.now();
      session.writing.prewriting = { text: cleaned, submittedAt };
      session.steps.prewriting = { completed: true, submittedAt };
      if (canAdvanceToStage2) {
        session.stage = Math.max(Number(session.stage || 1), 2);
      }
      return session;
    });
    return attachTimer(updated);
  }

  async function saveDraft(sessionKey, text) {
    const cleaned = String(text || '').trim();
    if (!cleaned) throw createError(400, '2단계 메모를 입력해주세요.');
    const updated = await dataStore.updateSession(sessionKey, (session) => {
      ensureWriting(session);
      ensureSteps(session);
      const savedAt = Date.now();
      session.writing.draft = { text: cleaned, savedAt };
      session.steps.draft = { saved: true, savedAt };
      return session;
    });
    return attachTimer(updated);
  }

  async function savePeerNotes(sessionKey, text) {
    const cleaned = String(text || '').trim();
    if (!cleaned) throw createError(400, '3단계 메모를 입력해주세요.');
    const updated = await dataStore.updateSession(sessionKey, (session) => {
      ensureWriting(session);
      ensureSteps(session);
      const updatedAt = Date.now();
      session.writing.notes = { text: cleaned, updatedAt };
      session.steps.notes = { saved: true, updatedAt };
      return session;
    });
    return attachTimer(updated);
  }

  async function submitFinalWriting(sessionKey, text) {
    const cleaned = String(text || '').trim();
    if (!cleaned) throw createError(400, '최종 글을 입력해주세요.');
    const current = await dataStore.getSession(sessionKey);
    if (!current) throw createError(404, '세션을 찾을 수 없습니다.');
    await ensureTimerAllowsStageChange(current, 4);
    const updated = await dataStore.updateSession(sessionKey, (session) => {
      ensureWriting(session);
      ensureSteps(session);
      const submittedAt = Date.now();
      session.writing.final = { text: cleaned, submittedAt };
      session.steps.final = { submitted: true, submittedAt };
      session.stage = 4;
      return session;
    });
    return attachTimer(updated);
  }

  async function setPartner(sessionKey, payload = {}) {
    const { partnerSessionKey, partnerName, partnerId } = payload;
    const session = await dataStore.getSession(sessionKey);
    if (!session) {
      throw createError(404, '세션을 찾을 수 없습니다.');
    }

    const normalizedPartnerKey = normalizeId(partnerSessionKey);
    const normalizedPartnerId = normalizeId(partnerId);
    let partnerSession = null;

    if (normalizedPartnerKey) {
      partnerSession = await dataStore.getSession(normalizedPartnerKey);
      if (!partnerSession) {
        throw createError(404, '동료 세션을 찾을 수 없습니다.');
      }
    }

    const manualAllowed = await ensurePartnerAllowed(partnerSessionKey, partnerId, partnerName);

    if (!partnerSession && normalizedPartnerId) {
      partnerSession = await findExistingSessionByStudentId(normalizedPartnerId);
    }

    if (partnerSession && partnerSession.sessionKey === session.sessionKey) {
      throw createError(400, '본인 세션을 동료로 지정할 수 없습니다.');
    }

    if (!partnerSession) {
      if (!manualAllowed) {
        throw createError(404, '동료 세션을 찾을 수 없습니다.');
      }
      const offlinePartner = {
        sessionKey: '',
        name: manualAllowed.name,
        id: manualAllowed.id,
        stage: Number(manualAllowed.stage || 1)
      };
      const updated = await dataStore.updateSession(session.sessionKey, (record) => {
        ensureWriting(record);
        ensureSteps(record);
        rememberRosterPairing({ id: session.you?.id, name: session.you?.name }, manualAllowed);
        record.partner = offlinePartner;
        record.presence = record.presence || {};
        record.presence.partner = {
          ...(record.presence.partner || {}),
          sessionKey: '',
          name: manualAllowed.name,
          id: manualAllowed.id,
          stage: Number(manualAllowed.stage || 1),
          online: false,
          lastSeen: 0
        };
        return record;
      });
      return attachTimer(updated);
    }

    const fallbackInfo = manualAllowed || {
      id: normalizedPartnerId,
      name: normalizeName(partnerName)
    };

    rememberRosterPairing(session.you || { id: session.you?.id, name: session.you?.name }, fallbackInfo || partnerSession.you);
    const { sharedId, mergeSources } = await determineSharedPeerSessionId(session, partnerSession);
    const partnerSnapshot = buildPartnerSnapshot(partnerSession, fallbackInfo || {}, true);
    const partnerPresence = buildPartnerPresence(partnerSession, fallbackInfo || {});
    const selfSnapshot = buildPartnerSnapshot(session, { id: session.you?.id, name: session.you?.name }, true);
    const selfPresence = buildPartnerPresence(session, { id: session.you?.id, name: session.you?.name });

    const [updatedSession, updatedPartner] = await Promise.all([
      dataStore.updateSession(session.sessionKey, (record) => {
        ensureWriting(record);
        ensureSteps(record);
        record.partner = partnerSnapshot;
        record.presence = record.presence || {};
        record.presence.partner = partnerPresence;
        record.peerSessionId = sharedId;
        return record;
      }),
      dataStore.updateSession(partnerSession.sessionKey, (record) => {
        console.log('[ensureRosterPairing] 동료 세션 업데이트:', {
          sessionKey: partnerSession.sessionKey,
          oldPeerSessionId: record.peerSessionId,
          newPeerSessionId: sharedId
        });
        
        ensureWriting(record);
        ensureSteps(record);
        record.partner = selfSnapshot;
        record.presence = record.presence || {};
        record.presence.partner = selfPresence;
        record.peerSessionId = sharedId;
        return record;
      })
    ]);

    if (mergeSources.length) {
      await mergePeerChatHistories(sharedId, mergeSources);
    }

    await Promise.all([updatePartnerMirrorPresence(updatedSession), updatePartnerMirrorPresence(updatedPartner)]);
    return attachTimer(updatedSession);
  }

  async function clearPartner(sessionKey) {
    const updated = await dataStore.updateSession(sessionKey, (session) => {
      session.partner = null;
      return session;
    });
    return attachTimer(updated);
  }

  async function advanceToPeerStage(sessionKey) {
    const current = await dataStore.getSession(sessionKey);
    if (!current) throw createError(404, '세션을 찾을 수 없습니다.');
    const nextStage = computeNextStageForAdvance(current);
    await ensureTimerAllowsStageChange(current, nextStage);
    const updated = await dataStore.updateSession(sessionKey, (session) => {
      const nextStage = computeNextStageForAdvance(session);
      advanceStageValue(session, nextStage);
      return session;
    });
    return attachTimer(updated);
  }

  async function advanceToFinalStage(sessionKey) {
    const current = await dataStore.getSession(sessionKey);
    if (!current) throw createError(404, '세션을 찾을 수 없습니다.');
    await ensureTimerAllowsStageChange(current, 4);
    const updated = await dataStore.updateSession(sessionKey, (session) => {
      advanceStageValue(session, 4);
      return session;
    });
    return attachTimer(updated);
  }

  async function regressStage(sessionKey) {
    const updated = await dataStore.updateSession(sessionKey, (session) => {
      const previous = getPreviousStage(session);
      session.stage = previous;
      return session;
    });
    return attachTimer(updated);
  }

  async function jumpToStage(sessionKey, targetStage) {
    const target = Number(targetStage);
    if (!target || target < 1 || target > 4) throw createError(400, '유효하지 않은 단계입니다.');
    const current = await dataStore.getSession(sessionKey);
    if (!current) throw createError(404, '세션을 찾을 수 없습니다.');
    await ensureTimerAllowsStageChange(current, target);
    const updated = await dataStore.updateSession(sessionKey, (session) => {
      session.stage = target;
      return session;
    });
    return attachTimer(updated);
  }

  async function touchPresence(sessionKey) {
    const updated = await dataStore.updateSession(sessionKey, (session) => {
      const now = Date.now();
      session.presence = session.presence || {};
      session.presence.self = {
        ...(session.presence.self || {}),
        online: true,
        lastSeen: now,
        stage: session.stage
      };
      return session;
    });
    await updatePartnerMirrorPresence(updated);
    return attachTimer(updated);
  }

  async function postPresenceLeave(sessionKey, userId, userName) {
    const updated = await dataStore.updateSession(sessionKey, (session) => {
      const now = Date.now();
      session.presence = session.presence || {};
      session.presence.self = {
        ...(session.presence.self || {}),
        online: false,
        lastSeen: now,
        stage: session.stage,
        name: userName,
        id: userId
      };
      return session;
    });
    await updatePartnerMirrorPresence(updated);
    return attachTimer(updated);
  }

  async function getTimerState(mode = 'A') {
    const timer = await getTimer();
    return buildTimerSnapshot(timer, mode);
  }

  async function updateTimerConfig(payload = {}) {
    const current = await getTimer(true);
    const next = normalizeTimer({
      ...current,
      running: current.running,
      startedAt: current.startedAt,
      durations: {
        ...current.durations,
        ...(payload?.durations || payload || {})
      },
      updatedAt: Date.now()
    });
    if (typeof dataStore.saveTimer !== 'function') return next;
    const saved = await dataStore.saveTimer(next);
    timerCache = normalizeTimer(saved || next);
    timerFetchedAt = Date.now();
    return buildTimerSnapshot(timerCache, 'A');
  }

  async function startTimer() {
    const current = await getTimer(true);
    const started = normalizeTimer({
      ...current,
      running: true,
      startedAt: Date.now(),
      updatedAt: Date.now()
    });
    if (typeof dataStore.saveTimer !== 'function') return buildTimerSnapshot(started, 'A');
    const saved = await dataStore.saveTimer(started);
    timerCache = normalizeTimer(saved || started);
    timerFetchedAt = Date.now();
    return buildTimerSnapshot(timerCache, 'A');
  }

  async function stopTimer() {
    const current = await getTimer(true);
    const stopped = normalizeTimer({
      ...current,
      running: false,
      updatedAt: Date.now()
    });
    if (typeof dataStore.saveTimer !== 'function') return buildTimerSnapshot(stopped, 'A');
    const saved = await dataStore.saveTimer(stopped);
    timerCache = normalizeTimer(saved || stopped);
    timerFetchedAt = Date.now();
    return buildTimerSnapshot(timerCache, 'A');
  }

  async function resetTimer() {
    const current = await getTimer(true);
    const reset = normalizeTimer({
      ...current,
      running: false,
      startedAt: 0,
      updatedAt: Date.now()
    });
    if (typeof dataStore.saveTimer !== 'function') return buildTimerSnapshot(reset, 'A');
    const saved = await dataStore.saveTimer(reset);
    timerCache = normalizeTimer(saved || reset);
    timerFetchedAt = Date.now();
    return buildTimerSnapshot(timerCache, 'A');
  }

  async function getPublicSettings() {
    return dataStore.getPublicSettings();
  }

  async function getServerDiag() {
    return dataStore.getServerDiag();
  }

  async function deleteSession(sessionKey) {
    const key = String(sessionKey || '').trim();
    if (!key) {
      throw createError(400, '세션 키를 입력하세요.');
    }
    const session = await dataStore.getSession(key);
    if (!session) {
      throw createError(404, '세션을 찾을 수 없습니다.');
    }
    await dataStore.deleteSession(key, session);
    return { sessionKey: key };
  }

  return {
    startSession,
    listSessions,
    getSessionState,
    submitPrewriting,
    saveDraft,
    savePeerNotes,
    submitFinalWriting,
    setPartner,
    clearPartner,
    advanceToPeerStage,
    advanceToFinalStage,
    regressStage,
    jumpToStage,
    touchPresence,
    postPresenceLeave,
    getAllSessionsWithDetails: async () => {
      const list = await listSessions();
      const detailed = await Promise.all(
        list.map(async (record) => {
          try {
            const session = await getSessionState(record.sessionKey);
            return session;
          } catch (error) {
            return null;
          }
        })
      );
      return detailed.filter(Boolean);
    },
    getPublicSettings,
    getServerDiag,
    getTimerState,
    updateTimerConfig,
    startTimer,
    stopTimer,
    resetTimer,
    deleteSession,
    seedRosterSessions,
    reloadRosterCache: () => {
      rosterCache = null;
      rosterPairingsCache = [];
      rosterFetchedAt = 0;
    }
  };
}


