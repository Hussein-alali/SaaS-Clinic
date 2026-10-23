-- ============================================================
-- Migration 2026-07-13 — Drop `modalities` column
--
-- The "الوسائل العلاجية" concept was removed from the product.
-- The treatment methods (طرق العلاج) field now covers every
-- clinical modality doctors select. This migration drops the
-- redundant column from both template and treatment tables and
-- rebuilds the RPCs that used to touch it.
--
-- Idempotent: safe to re-run.
-- ============================================================

alter table if exists treatment_templates drop column if exists modalities;
alter table if exists treatments           drop column if exists modalities;

-- The RPCs (create_treatment_template, update_treatment_template,
-- duplicate_treatment_template, restore_template_version,
-- create_treatment, update_treatment) are re-created by re-running
-- supabase-schema.sql and supabase-migration-treatments-2026-07-12.sql —
-- both of which no longer reference the column.
