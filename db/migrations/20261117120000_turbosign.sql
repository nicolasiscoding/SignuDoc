-- TurboSign: the TurboSign document an envelope was sent as, when the
-- install sends through TurboSign (TURBODOCX_API_KEY). Null for envelopes
-- SignuDoc sent itself.

alter table public.envelopes
  add column if not exists turbosign_document_id text;
