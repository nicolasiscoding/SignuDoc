import { NextResponse } from "next/server";

import { getDb } from "@/lib/db/connection";
import { logRouteError } from "@/lib/security/logging";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import { handleTurboSignWebhook } from "@/lib/turbosign-webhook";

/**
 * TurboSign's webhook. Public, so every delivery is checked against the
 * X-TurboDocx-Signature header before anything is read from it.
 */
export async function POST(request: Request) {
  try {
    const result = await handleTurboSignWebhook({
      database: getDb(),
      // The raw body: the signature covers the exact bytes TurboSign sent.
      rawBody: await request.text(),
      signature: request.headers.get("x-turbodocx-signature") ?? "",
      timestamp: request.headers.get("x-turbodocx-timestamp") ?? "",
    });

    return NextResponse.json(result.body, {
      headers: { "cache-control": "no-store" },
      status: result.status,
    });
  } catch (error) {
    logRouteError(error, {
      category: "turbosign_webhook_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "TurboSign webhook delivery failed.",
      path: getRequestPathname(request),
      userId: null,
    });

    // A 500 makes TurboSign retry the delivery later.
    return NextResponse.json(
      { error: "Unable to process this delivery." },
      { status: 500 },
    );
  }
}
