import assert from "node:assert/strict";
import test from "node:test";

import { toTurboSignRequest } from "./turbosign.ts";

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
