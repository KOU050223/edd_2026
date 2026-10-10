-- Stable per-question / per-concept identities across map applications.
ALTER TABLE learning_evidence ADD COLUMN observation_key TEXT;
CREATE UNIQUE INDEX idx_evidence_observation_concept
  ON learning_evidence(user_id, provider, observation_key, concept_ids)
  WHERE observation_key IS NOT NULL;
