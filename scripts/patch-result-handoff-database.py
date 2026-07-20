from pathlib import Path

path = Path('packages/db/src/database.ts')
text = path.read_text()
old = (
    "  worker_result_submissions: Row & {\n"
    "    execution_id: string;\n"
    "    attempt_id: string;\n"
    "    submission_digest: string;\n"
    "    result: Jsonb;\n"
    "  };\n"
)
new = (
    "  worker_result_submissions: Row & {\n"
    "    execution_id: string;\n"
    "    attempt_id: string;\n"
    "    submission_digest: string;\n"
    "    result: Jsonb;\n"
    "    committed_at: Timestamp | null;\n"
    "  };\n"
)
if text.count(old) != 1:
    raise SystemExit(f'expected one database type match, found {text.count(old)}')
path.write_text(text.replace(old, new))
