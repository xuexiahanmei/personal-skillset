#!/usr/bin/env python3
"""references/INSTALL.md carries both scripts inline so it works on a machine that has
nothing else. Check that those copies still match scripts/, or rewrite them with --fix.

    python tests/check_install_md.py         # exit 1 when they have drifted
    python tests/check_install_md.py --fix   # copy scripts/ into the md
"""
import re
import sys
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent
MD = SKILL / "references" / "INSTALL.md"
NAMES = ("fetch_models.py", "transcribe.py")


def main():
    fix = "--fix" in sys.argv[1:]
    text = MD.read_text(encoding="utf-8")
    stale = []
    for name in NAMES:
        code = (SKILL / "scripts" / name).read_text(encoding="utf-8")
        if "```" in code:
            sys.exit(f"{name} contains ``` and cannot be embedded in a fenced block")
        m = re.search(r"### %s\n\n```python\n(.*?)```" % re.escape(name), text, re.S)
        if not m:
            sys.exit(f"INSTALL.md has no '### {name}' python block")
        if m.group(1) != code:
            stale.append(name)
            text = text[: m.start(1)] + code + text[m.end(1):]
    if not stale:
        print("INSTALL.md matches scripts/")
    elif fix:
        MD.write_text(text, encoding="utf-8", newline="\n")
        print("rewrote " + ", ".join(stale) + " in INSTALL.md")
    else:
        sys.exit("INSTALL.md is stale for " + ", ".join(stale) + " - rerun with --fix")


if __name__ == "__main__":
    main()
