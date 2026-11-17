import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type pg from "pg";

import { openTestDatabase } from "./db/test-database.ts";
import { createStorageService } from "./services/storage.ts";
import {
  handleTurboSignWebhook,
  saveWebhookSecret,
} from "./turbosign-webhook.ts";

// TurboSign telling this install a document is finished or voided, against
// a real Postgres. Run with `npm run test:db`.

const SECRET = "whsec-test";
const SIGNED_PDF = Buffer.from("%PDF-1.7 signed by TurboSign");
const SETTINGS = [
  "BETTER_AUTH_SECRET",
  "STORAGE_DRIVER",
  "STORAGE_LOCAL_DIR",
  "TURBODOCX_WEBHOOK_SECRET",
] as const;

let database: pg.Pool;
let workDir: string;
const createdUsers: string[] = [];
const settingsBefore = new Map<string, string | undefined>();

before(async () => {
  database = await openTestDatabase();
  workDir = await mkdtemp(path.join(tmpdir(), "signudoc-tswebhook-"));

  for (const name of SETTINGS) {
    settingsBefore.set(name, process.env[name]);
  }

  process.env.BETTER_AUTH_SECRET = "test-secret-for-encryption-0123456789";
  process.env.STORAGE_DRIVER = "local";
  process.env.STORAGE_LOCAL_DIR = path.join(workDir, "storage");
  delete process.env.TURBODOCX_WEBHOOK_SECRET;
  await saveWebhookSecret(database, SECRET);
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.query(`delete from turbosign_settings`);
  await database.end();

  for (const [name, value] of settingsBefore) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  await rm(workDir, { force: true, recursive: true });
});

/** An envelope that went out through TurboSign. */
async function sentThroughTurboSign() {
  const userId = randomUUID();
  const envelopeId = randomUUID();
  const documentId = `ts-${randomUUID()}`;

  createdUsers.push(userId);
  await database.query(
    `insert into public."user" (id, name, email, role) values ($1, 'Sam', $2, 'user')`,
    [userId, `${userId}@example.test`],
  );
  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash, sent_at,
        turbosign_document_id
      ) values ($1, $2, 'Lease', 'sent', 'x.pdf', 'lease.pdf', 4, 1, $3, 1, $4)
    `,
    [envelopeId, userId, "a".repeat(64), documentId],
  );

  return { documentId, envelopeId, userId };
}

function delivery(event: string, documentId: string, secret = SECRET) {
  const rawBody = JSON.stringify({
    created_at: new Date().toISOString(),
    data: { document_id: documentId },
    event,
    event_id: randomUUID(),
    version: "1",
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature =
    "sha256=" +
    createHmac("sha256", secret)
      .update(`${timestamp}.${rawBody}`)
      .digest("hex");

  return { rawBody, signature, timestamp };
}

const download = async () => SIGNED_PDF;

async function envelopeRow(envelopeId: string) {
  return (
    await database.query<{
      completed_at: number | null;
      signed_pdf_key: string | null;
      status: string;
      voided_at: number | null;
    }>(
      `select status, signed_pdf_key, completed_at, voided_at from envelopes where id = $1`,
      [envelopeId],
    )
  ).rows[0]!;
}

test("completed: the signed PDF is kept with the envelope, which is completed", async () => {
  const envelope = await sentThroughTurboSign();

  const response = await handleTurboSignWebhook({
    ...delivery("signature.document.completed", envelope.documentId),
    database,
    download,
  });

  assert.equal(response.status, 200);
  const row = await envelopeRow(envelope.envelopeId);
  assert.equal(row.status, "completed");
  assert.ok(row.completed_at, "no completion time");
  assert.ok(row.signed_pdf_key, "no signed PDF kept");

  const stored = await createStorageService().getObject(row.signed_pdf_key);
  assert.deepEqual(Buffer.from(stored.body), SIGNED_PDF);
});

test("a delivery signed with the wrong secret changes nothing", async () => {
  const envelope = await sentThroughTurboSign();

  const response = await handleTurboSignWebhook({
    ...delivery("signature.document.completed", envelope.documentId, "wrong"),
    database,
    download,
  });

  assert.equal(response.status, 401);
  assert.equal((await envelopeRow(envelope.envelopeId)).status, "sent");
});

test("voided on TurboSign: the envelope is voided here too", async () => {
  const envelope = await sentThroughTurboSign();

  const response = await handleTurboSignWebhook({
    ...delivery("signature.document.voided", envelope.documentId),
    database,
    download,
  });

  assert.equal(response.status, 200);
  const row = await envelopeRow(envelope.envelopeId);
  assert.equal(row.status, "voided");
  assert.ok(row.voided_at, "no void time");
});

test("a document this install did not send is acknowledged and ignored", async () => {
  const response = await handleTurboSignWebhook({
    ...delivery("signature.document.completed", "ts-not-ours"),
    database,
    download: async () => {
      throw new Error("should not download");
    },
  });

  assert.equal(response.status, 200);
});

test("a repeated completed delivery downloads nothing and changes nothing", async () => {
  const envelope = await sentThroughTurboSign();
  await handleTurboSignWebhook({
    ...delivery("signature.document.completed", envelope.documentId),
    database,
    download,
  });
  const first = await envelopeRow(envelope.envelopeId);

  let downloads = 0;
  const response = await handleTurboSignWebhook({
    ...delivery("signature.document.completed", envelope.documentId),
    database,
    download: async () => {
      downloads += 1;
      return SIGNED_PDF;
    },
  });

  assert.equal(response.status, 200);
  assert.equal(downloads, 0);
  assert.deepEqual(await envelopeRow(envelope.envelopeId), first);
});
