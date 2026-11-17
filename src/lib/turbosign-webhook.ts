import { verifyWebhookSignature } from "@turbodocx/sdk";

import { getDb, queryOne, type DbExecutor } from "./db/connection.ts";
import {
  decryptPrivateKey,
  encryptPrivateKey,
  secretKeyFor,
} from "./services/seal-identity.ts";
import { createStorageService } from "./services/storage.ts";
import { buildEnvelopeSignedPdfKey } from "./services/storage-keys.ts";
import {
  downloadTurboSignPdf,
  ensureTurboSignWebhook,
  type WebhookSetupResult,
} from "./services/turbosign.ts";
import { resolveAppUrl } from "./utils/env.ts";

// TurboSign tells this install when a document it sent is finished or
// voided. The signed PDF is then kept with the envelope, so it downloads
// like any other signed copy.

const SECRET_CONTEXT = "signudoc/turbosign-webhook/v1";

export async function saveWebhookSecret(
  database: DbExecutor,
  secret: string,
): Promise<void> {
  await database.query(
    `
      insert into turbosign_settings (id, webhook_secret_encrypted, updated_at)
      values (true, $1, $2)
      on conflict (id) do update
        set webhook_secret_encrypted = excluded.webhook_secret_encrypted,
            updated_at = excluded.updated_at
    `,
    [
      encryptPrivateKey(secret, secretKeyFor(SECRET_CONTEXT)),
      Math.floor(Date.now() / 1000),
    ],
  );
}

/** TURBODOCX_WEBHOOK_SECRET, for a webhook set up by hand, or the stored one. */
export async function readWebhookSecret(
  database: DbExecutor,
): Promise<string | null> {
  if (process.env.TURBODOCX_WEBHOOK_SECRET) {
    return process.env.TURBODOCX_WEBHOOK_SECRET;
  }

  const row = await queryOne<{ value: string }>(
    database,
    `select webhook_secret_encrypted as value from turbosign_settings where id`,
    [],
  );

  return row
    ? decryptPrivateKey(row.value, secretKeyFor(SECRET_CONTEXT))
    : null;
}

let setup: Promise<WebhookSetupResult> | null = null;

/**
 * Sets up the webhook the first time this install sends through TurboSign.
 * Once per process; a failure is logged and tried again on the next send.
 */
export function setUpTurboSignWebhookOnce(
  database: DbExecutor = getDb(),
): Promise<WebhookSetupResult | null> {
  setup ??= (async () =>
    ensureTurboSignWebhook({
      appUrl: resolveAppUrl() ?? "",
      hasSecret: Boolean(await readWebhookSecret(database)),
      saveSecret: (secret) => saveWebhookSecret(database, secret),
    }))();

  return setup
    .then((result) => {
      if (
        result !== "ready" &&
        result !== "created" &&
        result !== "secret_rotated"
      ) {
        console.warn(`[turbosign] webhook not set up: ${result}`);
      }
      return result;
    })
    .catch((error: unknown) => {
      setup = null;
      console.error("[turbosign] webhook setup failed", error);
      return null;
    });
}

type EnvelopeRow = { id: string; status: string; userId: string };

export async function handleTurboSignWebhook({
  database = getDb(),
  download = (documentId: string) => downloadTurboSignPdf(documentId),
  rawBody,
  signature,
  timestamp,
}: {
  database?: DbExecutor;
  download?: (documentId: string) => Promise<Buffer>;
  rawBody: string;
  signature: string;
  timestamp: string;
}): Promise<{ status: number; body: { error?: string; ok?: true } }> {
  const secret = await readWebhookSecret(database);

  if (!secret) {
    return { body: { error: "Webhook is not set up." }, status: 503 };
  }

  if (!verifyWebhookSignature(rawBody, signature, timestamp, secret)) {
    return { body: { error: "Invalid signature." }, status: 401 };
  }

  const delivery = JSON.parse(rawBody) as {
    data?: { document_id?: string };
    event?: string;
  };
  const documentId = delivery.data?.document_id;
  const envelope = documentId
    ? await queryOne<EnvelopeRow>(
        database,
        `select id, status, user_id as "userId" from envelopes where turbosign_document_id = $1`,
        [documentId],
      )
    : null;

  // Not one of ours, or already settled: acknowledge so TurboSign stops retrying.
  if (!documentId || !envelope || envelope.status !== "sent") {
    return { body: { ok: true }, status: 200 };
  }

  const now = Math.floor(Date.now() / 1000);

  if (delivery.event === "signature.document.completed") {
    const key = buildEnvelopeSignedPdfKey({
      envelopeId: envelope.id,
      userId: envelope.userId,
    });

    await createStorageService().putObject({
      body: new Uint8Array(await download(documentId)),
      contentType: "application/pdf",
      key,
    });
    // ponytail: no SignuDoc audit row or completion emails; TurboSign sent the signed copy and keeps the audit trail.
    await database.query(
      `
        update envelopes
        set status = 'completed', completed_at = $1, signed_pdf_key = $2, updated_at = $1
        where id = $3 and status = 'sent'
      `,
      [now, key, envelope.id],
    );
  }

  if (delivery.event === "signature.document.voided") {
    await database.query(
      `
        update envelopes
        set status = 'voided', voided_at = $1, updated_at = $1
        where id = $2 and status = 'sent'
      `,
      [now, envelope.id],
    );
  }

  return { body: { ok: true }, status: 200 };
}
