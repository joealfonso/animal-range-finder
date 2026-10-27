---
description: Run a one-shot review of a file or pasted work under a named lens
argument-hint: <lens name> <file path or what to review>
---

Use the reviewer subagent for this. Input: $ARGUMENTS

The first words are the lens name, matched against the files in .claude/lenses/review/ by file name or title. The rest is the material: a file path, a diff, or a description of what to review. If no lens is given, list the titles in .claude/lenses/review/ and ask which one.

If the name matches a lens in .claude/lenses/rehearse/, don't run it here. Tell me to use /rehearse instead.

Return the reviewer's verdict as it came back. Don't soften it or add to it.
