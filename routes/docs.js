import express from 'express';
import {
  apiDocumentationIndex,
  createOpenApiDocument,
} from '../docs/openapi.js';

const router = express.Router();

router.get('/', (req, res) => {
  const serverUrl = `${req.protocol}://${req.get('host')}`;
  const document = createOpenApiDocument({ serverUrl });
  res.set('Cache-Control', 'public, max-age=300');
  res.json(apiDocumentationIndex(document));
});

router.get('/openapi.json', (req, res) => {
  const serverUrl = `${req.protocol}://${req.get('host')}`;
  res.set('Cache-Control', 'public, max-age=300');
  res.type('application/json').json(createOpenApiDocument({ serverUrl }));
});

export default router;
