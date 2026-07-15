# Declaration content identity

Registration and static-system digests are SHA-256 hashes of the canonical UTF-8 JSON representation of the complete parsed declaration envelope. The digest includes `apiVersion`, `kind`, natural-key `metadata`, and `spec`; callers cannot supply or override it. Object keys are sorted recursively and array order is preserved, so semantically equivalent YAML and JSON produce the same digest after parsing.
