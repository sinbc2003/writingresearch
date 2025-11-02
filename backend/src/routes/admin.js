import express from 'express';
import createError from 'http-errors';

export function createAdminRouter({ adminService, sessionService, chatService }) {
  if (!adminService || !sessionService || !chatService) {
    throw new Error('adminService, sessionService, chatService가 필요합니다.');
  }

  const router = express.Router();

  router.post('/login', async (req, res, next) => {
    try {
      const password = req.body?.password || '';
      if (!adminService.verifyPassword(password)) {
        throw createError(401, '인증에 실패했습니다.');
      }
      const { token, expiresAt } = adminService.issueToken();
      res.json({ token, expiresAt });
    } catch (error) {
      next(error);
    }
  });

  router.use((req, res, next) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!adminService.validateToken(token)) {
      res.status(401).json({ error: '인증이 필요합니다.' });
      return;
    }
    req.adminToken = token;
    next();
  });

  router.post('/logout', (req, res) => {
    if (req.adminToken) {
      adminService.revokeToken(req.adminToken);
    }
    res.json({ ok: true });
  });

  router.get('/sessions', async (req, res, next) => {
    try {
      const sessions = await sessionService.listSessions();
      res.json({ sessions });
    } catch (error) {
      next(error);
    }
  });

  router.get('/sessions/:sessionKey', async (req, res, next) => {
    try {
      const session = await sessionService.getSessionState(req.params.sessionKey);
      res.json({ session });
    } catch (error) {
      next(error);
    }
  });

  router.post('/sessions/:sessionKey/partner', async (req, res, next) => {
    try {
      const updated = await sessionService.setPartner(req.params.sessionKey, req.body || {});
      res.json({ session: updated });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/sessions/:sessionKey/partner', async (req, res, next) => {
    try {
      const updated = await sessionService.clearPartner(req.params.sessionKey);
      res.json({ session: updated });
    } catch (error) {
      next(error);
    }
  });

  router.get('/sessions/:sessionKey/chats/:channel', async (req, res, next) => {
    try {
      const { sessionKey, channel } = req.params;
      const normalizedChannel = channel === 'peer' || channel === 'peer-chat' ? 'peer' : 'ai';
      const history = await chatService.getChatHistory(sessionKey, normalizedChannel);
      res.json({ messages: history });
    } catch (error) {
      next(error);
    }
  });

  router.get('/config', async (req, res, next) => {
    try {
      const config = await adminService.getConfig();
      res.json(config);
    } catch (error) {
      next(error);
    }
  });

  router.post('/config', async (req, res, next) => {
    try {
      const result = await adminService.updateConfig(req.body || {});
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

