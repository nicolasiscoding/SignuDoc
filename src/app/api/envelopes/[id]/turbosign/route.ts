import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { getDb } from "@/lib/db/connection";
import { getTurboSignDocumentIdForUser } from "@/lib/envelopes";
import { downloadTurboSignPdf } from "@/lib/services/turbosign";

type RouteContext = { params: Promise<{ id: string }> };

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
