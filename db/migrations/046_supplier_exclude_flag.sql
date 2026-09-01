-- 046_supplier_exclude_flag.sql
--
-- Keep a supplier out of the recommendations.
--
-- The review measured that ארכיון ב.א contributes 291 permanently-"overdue"
-- rows: it sells, but holds zero warehouse stock BY DESIGN, so every one of its
-- items reads as 91 days late forever. Those are not orders anyone will place,
-- and they are a fifth of the noise on the screen.
--
-- A flag rather than a hardcoded name: which suppliers are archive-like is a
-- fact about the client's operation, and the buyer is the person who knows it.
--
-- Defaults to false, so every existing row keeps behaving exactly as it does.

ALTER TABLE supplier_settings
  ADD COLUMN IF NOT EXISTS excluded BOOLEAN NOT NULL DEFAULT false;
