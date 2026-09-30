# Feedback clustering recovery

Clustering improves the digest's already-extracted per-comment claims; it is
not a prerequisite for completing an analysis.

- Valid themes retain their unambiguous memberships.
- Invalid member references are excluded, and repeated references within one
  theme count once.
- References shared by multiple usable themes are removed from all competing
  themes. Those comments and omitted inputs retain their original claims.
- Invalid labels, mixed-category themes, and unrelated themes sharing a
  normalized label fall back to original claims rather than inventing counts.
- Invalid whole responses or clustering-request failures use original claims
  for the affected category. Other categories retain their valid results.

Original claims group by the existing sanitized, normalized exact wording in
a separate pool from AI themes. This conservative recovery may undercount
similar feedback, but does not silently assign ambiguous evidence to a theme.
The minimum-comments threshold is applied after recovery.

Recovered digests complete normally and advance their processing markers in
the existing transaction. Classification failures retain their separate
count, and the credit ledger's existing deduplication remains unchanged.
An analysis that successfully finds no recurring feedback shows an empty
state, including when some below-threshold comments are pooled. An analysis
where every classification fails remains unavailable, not an empty success.
Expired deadlines, missing resolved keys, and internal errors still fail or
defer through the existing handlers.

Completed digests persist the nullable `clustering_degraded` flag. A recovery
notice is shown on the selected digest, including historical digests, and on
dry-run previews. Detailed reasons and fallback counts are logged server-side;
provider details are never returned to the browser. Previews write no digest,
evidence, history, or billing rows.

Migration `0050_feedback_clustering_recovery.sql` adds the nullable flag
without backfilling historical rows. Apply and verify the migration before
running code that reads it. Agent operations target the isolated dev database
only; production migration and release remain human-operated.
