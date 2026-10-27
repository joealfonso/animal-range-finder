---
description: Start a live rehearsal with a named lens, played in this session
argument-hint: <lens name>
---

Run a rehearsal in this session. Do not hand it to a subagent, because a rehearsal is a conversation and a subagent returns one report.

1. Find the lens in .claude/lenses/rehearse/ that matches: $ARGUMENTS
   Match by file name or title, close matches fine. If nothing is given, list the titles in that folder and ask which one.
2. If the name matches a lens in .claude/lenses/review/, tell me to use /review instead and stop.
3. Read the lens file in full. Play it exactly as written. Open with its sample opening line, stay in character, follow its stop conditions, and end the way its output rules say, including the verdict.
4. If the lens needs material from me (a draft, a number, a situation) and I haven't given any, ask for it in character with the opening line and let me supply it as we go.
