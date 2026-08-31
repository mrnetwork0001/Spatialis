"""
Spatialis — Voice & Gesture 3D Spatial Interior Design Tool for SPECS
Built for the CLAD Summer Hackathon (Week 4: CREATE) — Lenslist & Snap SPECS.
Lens Studio 5.22+ / Spectacles Project Mode / Claude Code CLAD.

This is a repository status check, not part of the Lens itself. The Lens runs
entirely from Scripts/*.ts inside Lens Studio; this just reports what is
present so the submission state can be confirmed at a glance.

License: Apache-2.0
"""

import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))

SUBSYSTEMS = [
    ("1", "Voice Intent Engine", "Scripts/VoiceCommandController.ts"),
    ("2", "Hand Gesture Controller", "Scripts/SpatialGestureController.ts"),
    ("3", "Surface Anchor Engine", "Scripts/SurfaceAnchorEngine.ts"),
    ("4", "PBR Material Swapper", "Scripts/PBRMaterialSwapper.ts"),
]

SUPPORTING = [
    ("Shared core", "Scripts/SpatialisCore.ts"),
    ("Lens Studio API stubs", "types/lens-studio.d.ts"),
    ("Parser tests", "Tests/voice-parser.test.js"),
    ("Scene wiring guide", "SETUP_LENS_STUDIO.md"),
    ("CLAD transcript", "CLAD_PROMPT_LOG.txt"),
]

RULE = "=" * 74


def line_count(relative_path):
    """Number of lines in a repo file, or None when it does not exist."""
    full = os.path.join(ROOT, relative_path)
    if not os.path.isfile(full):
        return None
    with open(full, "r", encoding="utf-8") as handle:
        return sum(1 for _ in handle)


def report(rows, numbered):
    """Print one status block; returns the number of missing files."""
    missing = 0
    for row in rows:
        if numbered:
            index, label, path = row
            prefix = " {0}. {1:<26}".format(index, label)
        else:
            label, path = row
            prefix = "    {0:<29}".format(label)
        lines = line_count(path)
        if lines is None:
            missing += 1
            print("{0} MISSING  {1}".format(prefix, path))
        else:
            print("{0} ok  {1:>5} lines  {2}".format(prefix, lines, path))
    return missing


def main():
    print(RULE)
    print(" SPATIALIS — Voice & Gesture 3D Spatial Interior Design for SPECS")
    print(" CLAD Summer Hackathon, Week 4: CREATE   |   Deadline: Sept 6, 2026")
    print(RULE)

    print("\n Subsystems")
    missing = report(SUBSYSTEMS, numbered=True)

    print("\n Supporting")
    missing += report(SUPPORTING, numbered=False)

    print("\n" + RULE)
    if missing == 0:
        print(" All components present.")
        print(" Verify logic:  npm run typecheck  &&  npm test")
        print(" Run on SPECS:  see SETUP_LENS_STUDIO.md for scene wiring")
    else:
        print(" {0} component(s) MISSING — see the list above.".format(missing))
    print(RULE)

    return 0 if missing == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
