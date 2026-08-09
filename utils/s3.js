import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  endpoint: process.env.S3_ENDPOINT || undefined,
  forcePathStyle: Boolean(process.env.S3_ENDPOINT),
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Helper to get S3 key from a full S3 URL
export function getS3KeyFromUrl(url) {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/^\//, '');
  const bucketPrefix = `${process.env.S3_BUCKET}/`;
  return path.startsWith(bucketPrefix) ? path.slice(bucketPrefix.length) : path;
}

export async function uploadAttachmentToS3(fileBuffer, fileName, mimetype) {
  const bucket = process.env.S3_BUCKET;
  const key = `attachments/${Date.now()}-${fileName}`;
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: fileBuffer,
    ContentType: mimetype,
  });
  await s3.send(command);
  return `${process.env.S3_URL}/${key}`;
}

export async function uploadCsvToS3(fileBuffer, fileName, mimetype) {
  const bucket = process.env.S3_BUCKET;
  const key = `csv-uploads/${Date.now()}-${fileName}`;
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: fileBuffer,
    ContentType: mimetype,
  });
  await s3.send(command);
  return `${process.env.S3_URL}/${key}`;
}

export async function deleteAttachmentFromS3(s3Url) {
  const bucket = process.env.S3_BUCKET;
  const key = getS3KeyFromUrl(s3Url);
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

// ✅ Exported helper to get file buffer from S3
export async function getS3FileBufferFromUrl(s3Url) {
  const bucket = process.env.S3_BUCKET;
  const key = getS3KeyFromUrl(s3Url);
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  const response = await s3.send(command);

  const chunks = [];
  for await (const chunk of response.Body) {
    chunks.push(chunk);
  }

  return {
    buffer: Buffer.concat(chunks),
    key,
  };
}
