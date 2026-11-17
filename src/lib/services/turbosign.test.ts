import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureTurboSignWebhook,
  remindWithTurboSign,
  sendWithTurboSign,
  toTurboSignRequest,
  TURBOSIGN_WEBHOOK_PATH,
} from "./turbosign.ts";

const signers = [
  { email: "b@example.org", id: "s2", name: "Bea", signOrder: 2 },
  { email: "a@example.org", id: "s1", name: "Al", signOrder: 1 },
];
const letter = [{ height: 792, width: 612 }];

test("maps fractions of the page to points from the top left, in signing order", () => {
  const request = toTurboSignRequest({
    fields: [
      {
        height: 0.05,
        page: 1,
        required: true,
        signerId: "s1",
        type: "signature",
        width: 0.25,
        x: 0.1,
        y: 0.5,
      },
      {
        height: 0.02,
        page: 1,
        required: false,
        signerId: "s2",
        type: "initials",
        width: 0.1,
        x: 0.5,
        y: 0.9,
      },
    ],
    pageSizes: letter,
    signers,
  });

  assert.ok(request);
  assert.deepEqual(request.recipients, [
    { email: "a@example.org", name: "Al", signingOrder: 1 },
    { email: "b@example.org", name: "Bea", signingOrder: 2 },
  ]);
  assert.deepEqual(request.fields[0], {
    height: 39.6,
    page: 1,
    pageHeight: 792,
    pageWidth: 612,
    recipientEmail: "a@example.org",
    type: "signature",
    width: 153,
    x: 61.2,
    y: 396,
  });
  // Signature and initials are always required on TurboSign.
  assert.equal(request.fields[1]?.type, "initial");
  assert.equal(request.fields[1]?.required, undefined);
});

test("keeps optional text fields optional", () => {
  const request = toTurboSignRequest({
    fields: [
      {
        height: 0.1,
        page: 1,
        required: false,
        signerId: "s1",
        type: "text",
        width: 0.1,
        x: 0,
        y: 0,
      },
    ],
    pageSizes: letter,
    signers,
  });

  assert.equal(request?.fields[0]?.required, false);
});

test("returns null when a field has no TurboSign match, so SignuDoc sends it", () => {
  for (const type of ["dropdown", "radio"] as const) {
    const request = toTurboSignRequest({
      fields: [
        {
          height: 0.1,
          page: 1,
          required: true,
          signerId: "s1",
          type,
          width: 0.1,
          x: 0,
          y: 0,
        },
      ],
      pageSizes: letter,
      signers,
    });

    assert.equal(request, null);
  }
});

// sendWithTurboSign, with the TurboSign client stubbed.

type SentRequest = Record<string, unknown>;

function stubClient(
  behavior: (request: SentRequest) => { documentId: string },
) {
  const calls: SentRequest[] = [];

  return {
    calls,
    client: {
      sendSignature: async (request: SentRequest) => {
        calls.push(request);
        return behavior(request);
      },
    },
  };
}

function apiError(message: string, statusCode?: number, code?: string) {
  return Object.assign(new Error(message), { code, statusCode });
}

const sendInput = {
  documentName: "Lease",
  fields: [
    {
      height: 0.05,
      page: 1,
      required: true,
      signerId: "s1",
      type: "signature" as const,
      width: 0.25,
      x: 0.1,
      y: 0.5,
    },
  ],
  pageSizes: letter,
  pdf: Buffer.from("%PDF"),
  senderEmail: "sam@example.org",
  senderName: "Sam Sender",
  signers,
};

test("a send TurboSign accepts returns its document id", async () => {
  const stub = stubClient(() => ({ documentId: "doc-1" }));
  const result = await sendWithTurboSign({ ...sendInput, client: stub.client });

  assert.deepEqual(result, { documentId: "doc-1", outcome: "sent" });
});

test("the sender goes on each send, not in the shared client config", async () => {
  const stub = stubClient(() => ({ documentId: "doc-1" }));

  await sendWithTurboSign({ ...sendInput, client: stub.client });

  assert.equal(stub.calls[0]?.senderEmail, "sam@example.org");
  assert.equal(stub.calls[0]?.senderName, "Sam Sender");
});

test("the free plan running out is reported, not thrown", async () => {
  for (const error of [
    apiError("Signature limit exceeded", 402, "SignatureLimitExceeded"),
    apiError("Payment required", 402),
  ]) {
    const stub = stubClient(() => {
      throw error;
    });

    assert.deepEqual(
      await sendWithTurboSign({ ...sendInput, client: stub.client }),
      { outcome: "limit_reached" },
    );
  }
});

test("any other TurboSign error reaches the sender", async () => {
  const stub = stubClient(() => {
    throw apiError("Invalid API key", 401, "AuthenticationError");
  });

  await assert.rejects(
    sendWithTurboSign({ ...sendInput, client: stub.client }),
    /Invalid API key/,
  );
});

test("an envelope with a dropdown never reaches TurboSign", async () => {
  const stub = stubClient(() => ({ documentId: "doc-1" }));
  const result = await sendWithTurboSign({
    ...sendInput,
    client: stub.client,
    fields: [{ ...sendInput.fields[0]!, type: "dropdown" as const }],
  });

  assert.deepEqual(result, { outcome: "unsupported_fields" });
  assert.equal(stub.calls.length, 0);
});

// Reminders and the deadline go to TurboSign with the send.

test("the sender's reminder interval and deadline go to TurboSign", async () => {
  const stub = stubClient(() => ({ documentId: "doc-1" }));

  await sendWithTurboSign({
    ...sendInput,
    client: stub.client,
    expiresInDays: 14,
    reminderIntervalDays: 3,
  });

  const sent = stub.calls[0]!;
  assert.equal(sent.remindersEnabled, true);
  assert.deepEqual(sent.reminderDelay, { unit: "days", value: 3 });
  assert.deepEqual(sent.reminderInterval, { unit: "days", value: 3 });
  // SignuDoc reminds until the deadline; the deadline is the cap.
  assert.equal(sent.maxReminders, -1);
  assert.equal(sent.expirationEnabled, true);
  assert.deepEqual(sent.expireAfter, { unit: "days", value: 14 });
});

test("reminders the sender turned off stay off on TurboSign", async () => {
  const stub = stubClient(() => ({ documentId: "doc-1" }));

  await sendWithTurboSign({ ...sendInput, client: stub.client });

  assert.equal(stub.calls[0]?.remindersEnabled, false);
  assert.equal(stub.calls[0]?.expirationEnabled, false);
});

test("a manual reminder asks TurboSign to remind whoever's turn it is", async () => {
  const calls: unknown[][] = [];
  const client = {
    sendReminder: async (...args: unknown[]) => {
      calls.push(args);
      return {
        results: [
          { recipientId: "r1", status: "sent" },
          { recipientId: "r2", status: "skipped_wrong_order" },
        ],
      };
    },
  };

  const result = await remindWithTurboSign({ client, documentId: "doc-1" });

  assert.deepEqual(calls, [["doc-1"]]);
  assert.deepEqual(result, { reminded: 1 });
});

// Setting up the webhook that brings finished documents back.

function webhookStub(existing: unknown, options: { createError?: Error } = {}) {
  const calls: string[] = [];
  const saved: string[] = [];

  return {
    calls,
    saved,
    deps: {
      client: {
        createWebhook: async (request: {
          events: string[];
          urls: string[];
        }) => {
          calls.push(
            `create ${request.urls.join(",")} ${request.events.join(",")}`,
          );
          if (options.createError) throw options.createError;
          return { id: "wh-1", secret: "new-secret" };
        },
        getWebhook: async () => {
          calls.push("get");
          if (existing instanceof Error) throw existing;
          return existing as { urls: string[] };
        },
        regenerateWebhookSecret: async () => {
          calls.push("regenerate");
          return { secret: "rotated-secret" };
        },
      },
      saveSecret: async (secret: string) => {
        saved.push(secret);
      },
    },
  };
}

const appUrl = "https://sign.example.org";
const ourUrl = `${appUrl}${TURBOSIGN_WEBHOOK_PATH}`;
const notFound = () => apiError("Webhook not found", 404, "NotFoundError");

test("no webhook yet: one is created for this install and its secret kept", async () => {
  const stub = webhookStub(notFound());

  const result = await ensureTurboSignWebhook({
    appUrl,
    hasSecret: false,
    ...stub.deps,
  });

  assert.equal(result, "created");
  assert.deepEqual(stub.calls, [
    "get",
    `create ${ourUrl} signature.document.completed,signature.document.voided`,
  ]);
  assert.deepEqual(stub.saved, ["new-secret"]);
});

test("our webhook with its secret kept: nothing to do", async () => {
  const stub = webhookStub({ urls: [ourUrl] });

  assert.equal(
    await ensureTurboSignWebhook({ appUrl, hasSecret: true, ...stub.deps }),
    "ready",
  );
  assert.deepEqual(stub.calls, ["get"]);
});

test("our webhook but its secret was lost: rotate it, since only we listen", async () => {
  const stub = webhookStub({ urls: [ourUrl] });

  assert.equal(
    await ensureTurboSignWebhook({ appUrl, hasSecret: false, ...stub.deps }),
    "secret_rotated",
  );
  assert.deepEqual(stub.saved, ["rotated-secret"]);
});

test("someone else's webhook is never changed: its secret is shared", async () => {
  for (const urls of [
    ["https://other.example.com/hook"],
    [ourUrl, "https://other.example.com/hook"],
  ]) {
    const stub = webhookStub({ urls });

    assert.equal(
      await ensureTurboSignWebhook({ appUrl, hasSecret: false, ...stub.deps }),
      "existing_webhook_untouched",
    );
    assert.deepEqual(stub.calls, ["get"]);
    assert.deepEqual(stub.saved, []);
  }
});

test("an install without https can't receive webhooks, so TurboSign isn't asked", async () => {
  const stub = webhookStub(notFound());

  assert.equal(
    await ensureTurboSignWebhook({
      appUrl: "http://localhost:3000",
      hasSecret: false,
      ...stub.deps,
    }),
    "needs_https",
  );
  assert.deepEqual(stub.calls, []);
});

test("a key without the administrator role is reported, not thrown", async () => {
  const stub = webhookStub(apiError("Forbidden", 403, "AuthorizationError"));

  assert.equal(
    await ensureTurboSignWebhook({ appUrl, hasSecret: false, ...stub.deps }),
    "needs_admin_key",
  );
});
