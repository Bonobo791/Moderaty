-- Reconcile historical duplicates before the index can be created (human
-- review): the pre-index check-then-insert flow only reused UNEXPIRED pending
-- rows, so a resubmission after the previous pending row expired created a
-- second pending row for the same e-mail. Keep the newest pending row per
-- e-mail and drop the rest so the unique index can be built on an existing
-- database instead of aborting the migration.
DELETE FROM `contact_submissions`
WHERE `status` = 'pending'
  AND `id` NOT IN (
    SELECT MAX(`id`) FROM `contact_submissions` WHERE `status` = 'pending' GROUP BY `email`
  );
--> statement-breakpoint
CREATE UNIQUE INDEX `contact_submissions_pending_email_unique` ON `contact_submissions` (`email`) WHERE "contact_submissions"."status" = 'pending';
