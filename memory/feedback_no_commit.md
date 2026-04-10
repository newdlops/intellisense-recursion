---
name: feedback_no_commit
description: User does not want automatic git commits — only commit when explicitly asked
type: feedback
---

Do not commit unless the user explicitly asks to commit.

**Why:** User was frustrated by repeated unsolicited git commit attempts. They want to control when commits happen.

**How to apply:** Never run `git commit` or `git add` unless the user says "커밋해" or similar explicit instruction. Only modify files.
