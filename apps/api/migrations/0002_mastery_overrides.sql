CREATE TABLE mastery_overrides (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  concept_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('unobserved', 'learning', 'confirmed')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, concept_id)
);
