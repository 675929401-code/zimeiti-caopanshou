BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Keep the other fixed routes guarded. The commerce configuration service
-- validates the curated model identities on draft creation and release.
ALTER TABLE public.commerce_operation_routes
  DROP CONSTRAINT commerce_operation_routes_check,
  ADD CONSTRAINT commerce_operation_routes_check CHECK (
    NOT user_selectable
    OR model_kind = 'video'
    OR (model_kind = 'image' AND operation_id IN (
      'image.default', 'image.white-background', 'image.change-cloth',
      'image.clothing-redesign', 'image.product-use', 'image.image-refine',
      'image.face-turnaround', 'image.character-sheet', 'image.change-face',
      'image.face-fusion', 'image.background-change', 'image.portrait-realism'
    ))
  );

COMMIT;
