ALTER TABLE requests ADD COLUMN return_requested_qty INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN returned_qty INTEGER NOT NULL DEFAULT 0;

-- Keep historical full returns and any in-flight return reports consistent.
UPDATE requests SET returned_qty=qty WHERE status='returned';
UPDATE requests
SET return_requested_qty=qty-returned_qty
WHERE status='return_pending' AND return_requested_qty=0;
