// Sending an envelope through TurboSign (https://www.turbodocx.com).
//
// SignuDoc seals finished PDFs with its own self-signed certificate unless
// the install is given one, and a certificate on the Adobe Approved Trust
// List cannot be given as a file: its key has to stay in hardware. TurboSign
// signs with an AATL certificate held in an HSM and adds an RFC 3161
// timestamp, so the finished PDF opens as trusted in Adobe Acrobat.
//
// When TURBODOCX_API_KEY and TURBODOCX_ORG_ID are set, a simple-signature
// envelope is sent through TurboSign: its signers get TurboSign's signing
// link instead of SignuDoc's. The free TurboDocx plan covers 5 documents a
// month. When that runs out, or a field has no TurboSign match, the envelope
// is sent by SignuDoc as before.

import { TurboSign } from "@turbodocx/sdk";

import type { FieldType } from "../types/domain.ts";

type TurboSignFieldType =
  "signature" | "initial" | "date" | "text" | "checkbox";

// ponytail: dropdown and radio have no TurboSign match; those envelopes stay on SignuDoc.
const FIELD_TYPES: Partial<Record<FieldType, TurboSignFieldType>> = {
  checkbox: "checkbox",
  date: "date",
  initials: "initial",
  number: "text",
  signature: "signature",
  text: "text",
};

type SignerInput = {
  email: string;
  id: string;
  name: string;
  signOrder: number;
};

type FieldInput = {
  height: number;
  page: number;
  required: boolean;
  signerId: string;
  type: FieldType;
  width: number;
  x: number;
  y: number;
};

type PageSize = { height: number; width: number };

export type TurboSignFields = ReturnType<typeof toTurboSignRequest>;

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * SignuDoc keeps field positions as fractions of the page from its top left.
 * TurboSign takes points from the top left with the page size beside them.
 */
export function toTurboSignRequest({
  fields,
  pageSizes,
  signers,
}: {
  fields: readonly FieldInput[];
  pageSizes: readonly PageSize[];
  signers: readonly SignerInput[];
}) {
  const emailById = new Map(signers.map((signer) => [signer.id, signer.email]));
  const mapped = [];

  for (const field of fields) {
    const type = FIELD_TYPES[field.type];
    const size = pageSizes[field.page - 1];
    const recipientEmail = emailById.get(field.signerId);

    if (!type || !size || !recipientEmail) {
      return null;
    }

    const alwaysRequired = type === "signature" || type === "initial";

    mapped.push({
      height: round(field.height * size.height),
      page: field.page,
      pageHeight: size.height,
      pageWidth: size.width,
      recipientEmail,
      type,
      width: round(field.width * size.width),
      x: round(field.x * size.width),
      y: round(field.y * size.height),
      ...(alwaysRequired || field.required ? {} : { required: false }),
    });
  }

  return {
    fields: mapped,
    recipients: [...signers]
      .sort((a, b) => a.signOrder - b.signOrder)
      .map((signer) => ({
        email: signer.email,
        name: signer.name,
        signingOrder: signer.signOrder,
      })),
  };
}

let configured = false;

/** The SDK client, configured once for the process. */
function turboSignClient() {
  if (!configured) {
    // The sender goes on each send instead, so concurrent requests can't swap it.
    TurboSign.configure({
      apiKey: process.env.TURBODOCX_API_KEY,
      orgId: process.env.TURBODOCX_ORG_ID,
      skipSenderValidation: true,
    });
    configured = true;
  }

  return TurboSign;
}

/** What sending needs from the SDK, so tests can stand in for it. */
export type TurboSignClient = {
  sendSignature: (request: never) => Promise<{ documentId: string }>;
};

export function turboSignConfigured(env = process.env): boolean {
  return Boolean(env.TURBODOCX_API_KEY && env.TURBODOCX_ORG_ID);
}

export type TurboSignSendResult =
  | { documentId: string; outcome: "sent" }
  | { outcome: "limit_reached" | "unsupported_fields" };

/**
 * Sends the envelope through TurboSign. Errors other than the free plan
 * running out are thrown, so the sender sees them instead of a silent
 * switch to SignuDoc's own seal.
 */
export async function sendWithTurboSign({
  client,
  documentName,
  fields,
  pageSizes,
  pdf,
  senderEmail,
  senderName,
  signers,
}: {
  client?: TurboSignClient;
  documentName: string;
  fields: readonly FieldInput[];
  /** Each page's size in points, as the editor placed the fields on it. */
  pageSizes: readonly PageSize[];
  pdf: Buffer;
  senderEmail: string;
  senderName: string;
  signers: readonly SignerInput[];
}): Promise<TurboSignSendResult> {
  const request = toTurboSignRequest({ fields, pageSizes, signers });

  if (!request) {
    return { outcome: "unsupported_fields" };
  }

  const sdk = (client ?? turboSignClient()) as typeof TurboSign;

  try {
    const result = await sdk.sendSignature({
      documentName,
      // The page size goes with each field; the SDK's Field type does not list it yet.
      fields: request.fields as Parameters<
        typeof TurboSign.sendSignature
      >[0]["fields"],
      file: pdf,
      fileName: `${documentName}.pdf`,
      recipients: request.recipients,
      // Per request, not in configure(): the SDK client is shared across requests.
      senderEmail,
      senderName,
    });

    return { documentId: result.documentId, outcome: "sent" };
  } catch (error) {
    const { code, statusCode } = error as {
      code?: string;
      statusCode?: number;
    };

    if (code === "SignatureLimitExceeded" || statusCode === 402) {
      return { outcome: "limit_reached" };
    }

    throw error;
  }
}

/** The signed PDF, once every signer has signed. */
export async function downloadTurboSignPdf(
  documentId: string,
): Promise<Buffer> {
  const blob = await turboSignClient().download(documentId);

  return Buffer.from(await blob.arrayBuffer());
}
