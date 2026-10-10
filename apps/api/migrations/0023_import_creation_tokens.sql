-- Only the invocation that created a session may add its observations.
ALTER TABLE import_sessions ADD COLUMN creation_token TEXT;
