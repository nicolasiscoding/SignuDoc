import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

import type pg from "pg";

import { openTestDatabase } from "./db/test-database.ts";
import {
  replaceDraftEnvelopeFields,
  replaceDraftEnvelopeSigners,
  sendDraftEnvelope,
} from "./envelopes.ts";
import { createStorageService } from "./services/storage.ts";

// Sending through TurboSign, against a real Postgres, with TurboSign itself
// stood in for. Run with `npm run test:db`.

const SETTINGS = [
  "APP_URL",
  "DATABASE_URL",
  "EMAIL_CAPTURE_DIR",
  "EMAIL_DRIVER",
  "STORAGE_DRIVER",
  "STORAGE_LOCAL_DIR",
  "TURBODOCX_API_KEY",
  "TURBODOCX_ORG_ID",
] as const;

let database: pg.Pool;
let workDir: string;
const createdUsers: string[] = [];
const settingsBefore = new Map<string, string | undefined>();

before(async () => {
  database = await openTestDatabase();
  workDir = await mkdtemp(path.join(tmpdir(), "signudoc-turbosign-"));

  for (const name of SETTINGS) {
    settingsBefore.set(name, process.env[name]);
  }

  process.env.APP_URL = "http://localhost:3000";
  process.env.DATABASE_URL =
    process.env.E2E_DATABASE_URL ??
    "postgres://signudoc:signudoc@127.0.0.1:5432/signudoc_e2e";
  process.env.EMAIL_DRIVER = "capture";
  process.env.STORAGE_DRIVER = "local";
  process.env.STORAGE_LOCAL_DIR = path.join(workDir, "storage");
});

beforeEach(() => {
  // A fresh outbox per test, so each counts only its own emails.
  process.env.EMAIL_CAPTURE_DIR = path.join(workDir, `outbox-${randomUUID()}`);
  process.env.TURBODOCX_API_KEY = "test-key";
  process.env.TURBODOCX_ORG_ID = "test-org";
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
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

async function emailsSent(): Promise<number> {
  return (await readdir(process.env.EMAIL_CAPTURE_DIR!).catch(() => [])).length;
}

async function envelopeRow(envelopeId: string) {
  const result = await database.query<{
    status: string;
    turbosign_document_id: string | null;
  }>(`select status, turbosign_document_id from envelopes where id = $1`, [
    envelopeId,
  ]);

  return result.rows[0];
}

/** A two-signer draft on one US Letter page; the PDF bytes are a stand-in. */
async function createDraft() {
  const userId = randomUUID();
  const envelopeId = randomUUID();
  const sourcePdfKey = `test/${envelopeId}.pdf`;

  createdUsers.push(userId);
  await createStorageService().putObject({
    body: new Uint8Array([37, 80, 68, 70]),
    contentType: "application/pdf",
    key: sourcePdfKey,
  });
  await database.query(
    `insert into public."user" (id, name, email, role) values ($1, 'Sam Sender', $2, 'user')`,
    [userId, `${userId}@example.test`],
  );
  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash
      ) values ($1, $2, 'Lease', 'draft', $3, 'lease.pdf', 4, 1, $4)
    `,
    [envelopeId, userId, sourcePdfKey, "a".repeat(64)],
  );
  await database.query(
    `
      insert into envelope_pages (id, envelope_id, page_number, width_pt, height_pt)
      values ($1, $2, 1, 612, 792)
    `,
    [randomUUID(), envelopeId],
  );

  const saved = await replaceDraftEnvelopeSigners(
    userId,
    envelopeId,
    {
      signers: [
        { email: `riley-${randomUUID()}@example.test`, name: "Riley" },
        { email: `casey-${randomUUID()}@example.test`, name: "Casey" },
      ],
    },
    database,
  );
  const [riley, casey] = saved.signers.map((signer) => signer.id);

  await replaceDraftEnvelopeFields(
    userId,
    envelopeId,
    {
      fields: [
        {
          height: 0.05,
          page: 1,
          required: true,
          signerId: riley!,
          type: "signature",
          width: 0.25,
          x: 0.1,
          y: 0.5,
        },
        {
          height: 0.05,
          page: 1,
          required: true,
          signerId: casey!,
          type: "signature",
          width: 0.25,
          x: 0.5,
          y: 0.8,
        },
      ],
    },
    database,
  );

  return { envelopeId, userId };
}

function stubTurboSign(behavior: () => { documentId: string }) {
  const calls: Record<string, unknown>[] = [];

  return {
    calls,
    client: {
      sendSignature: async (request: Record<string, unknown>) => {
        calls.push(request);
        return behavior();
      },
    },
  };
}

const sender = { senderEmail: "sam@example.test", senderName: "Sam Sender" };

test("Send goes through TurboSign: the envelope is out, and SignuDoc emails no one", async () => {
  const draft = await createDraft();
  const turboSign = stubTurboSign(() => ({ documentId: "ts-doc-1" }));

  const result = await sendDraftEnvelope(
    draft.userId,
    draft.envelopeId,
    { ...sender, expiresInDays: 10, reminderIntervalDays: 2 },
    {
      database,
      turboSignClient: turboSign.client,
    },
  );

  // The sender's deadline and reminders go with the send.
  assert.equal(turboSign.calls[0]?.remindersEnabled, true);
  assert.deepEqual(turboSign.calls[0]?.reminderInterval, {
    unit: "days",
    value: 2,
  });
  assert.deepEqual(turboSign.calls[0]?.expireAfter, {
    unit: "days",
    value: 10,
  });

  assert.equal(result.turboSign, "sent");
  assert.deepEqual(await envelopeRow(draft.envelopeId), {
    status: "sent",
    turbosign_document_id: "ts-doc-1",
  });
  assert.equal(await emailsSent(), 0, "SignuDoc sent its own invitation too");

  // The fields land where the sender placed them on the 612 x 792 page.
  const fields = turboSign.calls[0]?.fields as Record<string, unknown>[];
  assert.deepEqual(
    fields.map(({ x, y, pageWidth, pageHeight }) => ({
      x,
      y,
      pageWidth,
      pageHeight,
    })),
    [
      { pageHeight: 792, pageWidth: 612, x: 61.2, y: 396 },
      { pageHeight: 792, pageWidth: 612, x: 306, y: 633.6 },
    ],
  );
});

test("after the free 5, Send falls back to SignuDoc and says so", async () => {
  const draft = await createDraft();
  const turboSign = stubTurboSign(() => {
    throw Object.assign(new Error("Signature limit exceeded"), {
      code: "SignatureLimitExceeded",
      statusCode: 402,
    });
  });

  const result = await sendDraftEnvelope(
    draft.userId,
    draft.envelopeId,
    sender,
    {
      database,
      turboSignClient: turboSign.client,
    },
  );

  assert.equal(result.turboSign, "limit_reached");
  assert.deepEqual(await envelopeRow(draft.envelopeId), {
    status: "sent",
    turbosign_document_id: null,
  });
  assert.equal(await emailsSent(), 1, "the first signer was not invited");
});

test("a TurboSign error other than the limit stops the send and leaves the draft", async () => {
  const draft = await createDraft();
  const turboSign = stubTurboSign(() => {
    throw Object.assign(new Error("Invalid API key"), { statusCode: 401 });
  });

  await assert.rejects(
    sendDraftEnvelope(draft.userId, draft.envelopeId, sender, {
      database,
      turboSignClient: turboSign.client,
    }),
    /Invalid API key/,
  );
  assert.equal((await envelopeRow(draft.envelopeId))?.status, "draft");
  assert.equal(await emailsSent(), 0);
});

test("without a TurboDocx key, Send is SignuDoc's own and TurboSign is never called", async () => {
  delete process.env.TURBODOCX_API_KEY;
  const draft = await createDraft();
  const turboSign = stubTurboSign(() => ({ documentId: "never" }));

  const result = await sendDraftEnvelope(
    draft.userId,
    draft.envelopeId,
    sender,
    {
      database,
      turboSignClient: turboSign.client,
    },
  );

  assert.equal(turboSign.calls.length, 0);
  assert.equal(result.turboSign, undefined);
  assert.equal(
    (await envelopeRow(draft.envelopeId))?.turbosign_document_id,
    null,
  );
});
