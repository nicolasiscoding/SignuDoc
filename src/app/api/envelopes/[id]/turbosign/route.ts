import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { getDb } from "@/lib/db/connection";
import { getTurboSignDocumentIdForUser } from "@/lib/envelopes";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import {
  downloadTurboSignPdf,
  remindWithTurboSign,
} from "@/lib/services/turbosign";

type RouteContext = { params: Promise<{ id: string }> };

/** Reminds whoever's turn it is on TurboSign, now. */
export async function POST(request: Request, context: RouteContext) {
  const session = await requireVerifiedSenderSession(request);

  if (session instanceof Response) {
    return session;
  }

  const { id } = await context.params;
  const rateLimitResponse = await applyRateLimit({
    category: "envelope_nudge",
    key: buildRateLimitKey(["envelope-nudge", session.user.id, id]),
    limit: 5,
    request,
    userId: session.user.id,
    windowMs: 60 * 60 * 1000,
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  const documentId = await getTurboSignDocumentIdForUser(
    session.user.id,
    id,
    getDb(),
  );

  if (!documentId) {
    return NextResponse.json({ error: "Envelope not found." }, { status: 404 });
  }

  const { reminded } = await remindWithTurboSign({ documentId });

  return NextResponse.json({ reminded }, { status: 200 });
}

/** The TurboSign-signed PDF of an envelope sent through TurboSign. */
export async function GET(request: Request, context: RouteContext) {
  const session = await requireVerifiedSenderSession(request);

  if (session instanceof Response) {
    return session;
  }

  const { id } = await context.params;
  const documentId = await getTurboSignDocumentIdForUser(
    session.user.id,
    id,
    getDb(),
  );

  if (!documentId) {
    return NextResponse.json({ error: "Envelope not found." }, { status: 404 });
  }

  try {
    const pdf = await downloadTurboSignPdf(documentId);

    return new Response(new Uint8Array(pdf), {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": `attachment; filename="signed-${id}.pdf"`,
        "content-type": "application/pdf",
      },
    });
  } catch {
    // ponytail: any TurboSign error reads as "not finished"; check getStatus if that misleads.
    return NextResponse.json(
      { error: "The signed PDF is ready once every signer has signed." },
      { status: 409 },
    );
  }
}
