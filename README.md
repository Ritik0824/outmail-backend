# OutMail Backend

OutMail is an email automation service that supports Google authentication,
encrypted mail credentials, CSV/XLSX campaign imports, reusable templates,
attachments, scheduled BullMQ delivery, and campaign history.

### Tech Stack
- Node.js
- Express
- PostgreSQL
- Nodemailer
- CSV Parser
- Multer
- AES Encryption

### Requirements

- Node.js 20 or newer
- Docker with Compose
- Google OAuth credentials
- An S3-compatible bucket

### Running locally

```bash
git clone https://github.com/Ritik0824/outmail-backend.git
cd outmail-backend
cp .env.example .env
docker compose up -d
npm ci
npm run db:deploy
```

Run the API and worker in separate terminals:

```bash
npm run dev
npm run dev:worker
```

The API listens on `http://localhost:3000` by default. Its liveness endpoint is
`GET /health/live`.

### Environment configuration

All supported variables are documented in `.env.example`. Startup fails with
a combined validation error when required values are absent or malformed.
Use independent random values for `JWT_SECRET` and `SECRET_KEY`; do not commit
the populated `.env` file.

`APP_ORIGINS` is a comma-separated browser origin allowlist.
`QUEUE_ADMIN_EMAILS` is a comma-separated list of authenticated users that may
access the queue dashboard.

### Database migrations

Create migrations during development with `npm run db:migrate`. Apply committed
migrations in test and production environments with `npm run db:deploy`.

### Folder structure
```
/config      → Environment and database configuration
/controllers → Business logic
/prisma      → Data model and committed migrations
/queue       → Queue and worker lifecycle
/routes      → API endpoints
/services    → Email logic
/utils       → Encryption
/uploads     → Temporary user uploads (ignored by Git)
```

### Contribution
Make a PR or open an issue to suggest improvements.
