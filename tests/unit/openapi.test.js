import assert from 'node:assert/strict';
import test from 'node:test';
import {
  apiDocumentationIndex,
  createOpenApiDocument,
  listApiOperations,
  openApiDocument,
  validateOpenApiDocument,
} from '../../docs/openapi.js';

test('the checked-in OpenAPI contract is internally consistent', () => {
  assert.deepEqual(validateOpenApiDocument(openApiDocument), []);
});

test('every API operation has a unique stable operation ID', () => {
  const operations = listApiOperations();
  const ids = operations.map(({ operationId }) => operationId);
  assert.ok(operations.length >= 35);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('startCampaign'));
  assert.ok(ids.includes('receiveDeliveryWebhook'));
  assert.ok(ids.includes('reconcileCampaignIntegrity'));
});

test('createOpenApiDocument safely sets the current server URL', () => {
  const document = createOpenApiDocument({ serverUrl: 'https://api.example.com/' });
  assert.equal(document.servers[0].url, 'https://api.example.com');
  assert.notEqual(document, openApiDocument);
  assert.throws(
    () => createOpenApiDocument({ serverUrl: 'file:///tmp/api' }),
    /must use http or https/,
  );
});

test('the documentation index reports contract inventory', () => {
  const index = apiDocumentationIndex();
  assert.equal(index.title, 'OutMail API');
  assert.equal(index.openapi, '3.1.0');
  assert.equal(index.operationCount, listApiOperations().length);
  assert.ok(index.schemaCount >= 25);
  assert.equal(index.specification, '/api/docs/openapi.json');
});

test('validation detects duplicate operation IDs and unresolved schemas', () => {
  const document = structuredClone(openApiDocument);
  document.paths['/duplicate'] = {
    get: {
      operationId: 'getLiveness',
      summary: 'Duplicate operation',
      responses: { 200: { description: 'ok' } },
    },
  };
  document.paths['/broken'] = {
    get: {
      operationId: 'getBrokenSchema',
      summary: 'Broken schema',
      responses: {
        200: {
          description: 'broken',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/DoesNotExist' },
            },
          },
        },
      },
    },
  };
  const errors = validateOpenApiDocument(document);
  assert.ok(errors.some((error) => error.includes('getLiveness is duplicated')));
  assert.ok(errors.some((error) => error.includes('DoesNotExist')));
});
