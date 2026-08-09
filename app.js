import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { createBullBoard } from '@bull-board/api';
import { ExpressAdapter } from '@bull-board/express';
import pkg from '@bull-board/api/dist/src/queueAdapters/bullMQ.js';
import authRoutes from './routes/auth.js';
import contactRoutes from './routes/contact.js';
import campaignsRouter from './routes/campaigns.js';
import templatesRouter from './routes/templates.js';
import emailUsageRoutes from './routes/emailUsage.js';
import resumesRouter from './routes/resumes.js';
import suppressionsRouter from './routes/suppressions.js';
import unsubscribeRouter from './routes/unsubscribe.js';
import { emailQueue } from './queue/emailQueue.js';
import { authenticateJWT, requireQueueAdmin } from './middleware/auth.js';

const { BullMQAdapter } = pkg;

export function createApp({ queue = emailQueue, enableQueueDashboard = true } = {}) {
  const app = express();
  const allowedOrigins = (process.env.APP_ORIGINS || 'http://localhost:8080')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('Origin is not allowed by CORS'));
    },
    credentials: true,
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(cookieParser());

  app.use('/api/auth', authRoutes);
  app.use('/api/auth', contactRoutes);
  app.use('/api/campaigns', campaignsRouter);
  app.use('/api/auth', emailUsageRoutes);
  app.use('/api/templates', templatesRouter);
  app.use('/api/resumes', resumesRouter);
  app.use('/api/suppressions', suppressionsRouter);
  app.use('/api/unsubscribe', unsubscribeRouter);

  if (enableQueueDashboard) {
    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath('/admin/queues');
    createBullBoard({
      queues: [new BullMQAdapter(queue)],
      serverAdapter,
    });
    app.use('/admin/queues', authenticateJWT, requireQueueAdmin, serverAdapter.getRouter());
  }

  app.get('/health/live', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.get('/', (_req, res) => {
    res.send('OutMail backend is running ✅');
  });

  app.use((err, _req, res, _next) => {
    if (err.message === 'Origin is not allowed by CORS') {
      res.status(403).json({ error: 'Origin is not allowed' });
      return;
    }
    console.error('Unhandled request error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
