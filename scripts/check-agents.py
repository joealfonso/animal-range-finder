#!/usr/bin/env python3
"""Check the agents, lenses, and commands in this repo. Stdlib only. Exits 1 on any problem."""
import pathlib
import re
import sys

root = pathlib.Path(__file__).resolve().parent.parent
problems = []
EM_DASH = chr(0x2014)


def front(path):
    text = path.read_text(encoding="utf-8")
    m = re.match(r"---\n(.*?)\n---\n", text, re.S)
    if not m:
        problems.append(f"{path.relative_to(root)}: missing frontmatter")
        return {}
    out = {}
    for line in m.group(1).splitlines():
        key, sep, value = line.partition(":")
        if sep:
            out[key.strip()] = value.strip()
    return out


# Agents: base roster plus every pack
agent_files = sorted((root / ".claude" / "agents").glob("*.md"))
agent_files += sorted((root / "packs").glob("*/agents/*.md"))
seen = {}
for path in agent_files:
    fm = front(path)
    rel = path.relative_to(root)
    if fm.get("name") != path.stem:
        problems.append(f"{rel}: name '{fm.get('name')}' does not match file name")
    for key in ("description", "tools"):
        if not fm.get(key):
            problems.append(f"{rel}: missing {key}")
    if path.stem in seen:
        problems.append(f"{rel}: duplicate agent name, also at {seen[path.stem]}")
    seen[path.stem] = rel

# Lenses
lens_counts = {}
for kind in ("review", "rehearse"):
    files = sorted((root / ".claude" / "lenses" / kind).glob("*.md"))
    lens_counts[kind] = len(files)
    for path in files:
        fm = front(path)
        rel = path.relative_to(root)
        if fm.get("name") != path.stem:
            problems.append(f"{rel}: name does not match file name")
        if fm.get("kind") != kind:
            problems.append(f"{rel}: kind '{fm.get('kind')}' is in the {kind} folder")
        for key in ("title", "use_for"):
            if not fm.get(key):
                problems.append(f"{rel}: missing {key}")
        text = path.read_text(encoding="utf-8")
        for needle in ("Stop conditions", "Output rules", "Sample opening line"):
            if needle not in text:
                problems.append(f"{rel}: missing '{needle}'")

# Commands
for path in sorted((root / ".claude" / "commands").glob("*.md")):
    if not front(path).get("description"):
        problems.append(f"{path.relative_to(root)}: missing description")
# No em dashes in the agents, lenses, and commands
# No em dashes anywhere in the repo's text files
for path in (root / ".claude").rglob("*"):
    if ".git" in path.parts or not path.is_file():
        continue
    if path.suffix in (".md", ".json", ".sh", ".py", ".txt") or path.name == ".gitignore":
        if EM_DASH in path.read_text(encoding="utf-8"):
            problems.append(f"{path.relative_to(root)}: contains an em dash")

print(f"agents: {len(agent_files)}  lenses: {lens_counts}")
if problems:
    print("\n".join(problems))
    sys.exit(1)
print("OK")
