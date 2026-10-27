# Animal Range Finder

Animals on an interactive 3D globe, built from GBIF occurrences, Wikipedia and Wikimedia Commons. For anyone curious where an animal lives.

## Stack and commands

- Stack: Vite + TypeScript + three.js via globe.gl. Static data committed under `public/`, no backend. Deployed on Cloudflare Workers from `main`.
- Run: `npm run dev` (http://localhost:5173)
- Build: `npm run build` (type-check, production build, SEO pages)
- Data: `npm run data` rebuilds everything from `data/species.csv`. `npm run check` validates the built data.
- Agents: `python3 scripts/check-agents.py` after editing an agent, lens, or command.

## How to work here

The main session orchestrates. Subagents can't spawn other subagents, so delegate from here.

- UI or flow work: designer writes the spec first, then engineer builds it. a11y-auditor checks it before it ships.
- Everything else (data scripts, build, tooling): spec-writer writes the acceptance criteria first, so test-writer has something to test against.
- Something is broken and the cause isn't obvious: debugger finds the root cause, then engineer fixes it.
- engineer never reviews its own work. After a change, run code-reviewer on the diff and test-writer against the spec.
- tech-writer keeps README.md and the in-app copy accurate. writer drafts anything that goes out under my name. marketer handles positioning, copy angles, and analytics.
- `/review <lens> <file>` runs a one-shot review under a lens. `/rehearse <lens>` starts a live role-play in this session. `/lenses` lists them.
- Lenses are reviewer roles. User personas are a different thing and live in docs/research/personas/.

## Rules

- No em dashes. Use commas. Say "I" for my own work, not "we".
- Don't invent metrics, results, or quotes. Leave a marked gap and ask.
- Primary sources over Wikipedia. Say so when you can't find one.
- Never weaken or delete a test to make it pass.
- If a feature's data can't be trusted, remove the feature rather than ship it.

## Project notes

- Agents, lenses, and commands come from https://github.com/joealfonso/agent-bank (base roster plus the web pack). Edit them here, the bank is only the starting point.
