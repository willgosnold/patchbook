"""Write cpython.json: what CPython's difflib, json and str give on the cases src/lib must match.

    python3 test/fixtures/generate.py
"""

import difflib
import json
import random
import shlex
from pathlib import Path

rng = random.Random(34)

CHARS = list("ab c\nxyz") + ["é", "é", "中", "文", "字", "😀", "👍🏽", " ", "\x0c", "﻿"]
LINES = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "", "a", "b", "x = 1",
         "é", "😀 emoji", "中文", "  indented", " nbsp", "line"]


def mutate(seq, rate=0.2):
    out = list(seq)
    for _ in range(max(1, int(len(out) * rate))):
        op = rng.choice("idr")
        at = rng.randrange(len(out) + 1)
        if op == "i" or not out:
            out[at:at] = [rng.choice(pool) for _ in range(rng.randint(1, 4))]
        elif op == "d":
            del out[at:at + rng.randint(1, 4)]
        else:
            out[at:at + 1] = [rng.choice(pool)]
    return out


def matcher_case(a, b, autojunk, lines):
    m = difflib.SequenceMatcher(None, a, b, autojunk=autojunk)
    return {"a": a, "b": b, "lines": lines, "autojunk": autojunk, "ratio": m.ratio(),
            "opcodes": [list(op) for op in m.get_opcodes()]}


matcher = []
for lines, pool, count, low, size in ((False, CHARS, 200, 0, 60), (False, CHARS, 14, 200, 260),
                                      (True, LINES, 100, 0, 40), (True, LINES, 8, 200, 240)):
    for _ in range(count):
        n = rng.randint(low, size)
        # Long sequences with a few popular elements exercise autojunk.
        weights = [rng.random() ** 3 for _ in pool]
        a = rng.choices(pool, weights, k=n)
        b = mutate(a) if rng.random() < 0.8 else rng.choices(pool, weights, k=rng.randint(low, size))
        if not lines:
            a, b = "".join(a), "".join(b)
        matcher.append(matcher_case(a, b, rng.random() < 0.5 if size > 100 else True, lines))
        if lines:
            matcher.append(matcher_case(a, b, not matcher[-1]["autojunk"], lines))

TEXT_LINES = ["one\n", "two\n", "three\n", "\n", "four\r\n", "five\x0c", "six ", "sept\x1c", "é\n", "😀\n", "last"]
unified = []
for _ in range(60):
    a = "".join(rng.choices(TEXT_LINES, k=rng.randint(0, 30)))
    b = "".join(mutate(list(a), 0.05)) if rng.random() < 0.5 else "".join(rng.choices(TEXT_LINES, k=rng.randint(0, 30)))
    unified.append({"a": a, "b": b, "fromfile": "upstream/x.md", "tofile": "disk/x.md",
                    "diff": "".join(difflib.unified_diff(a.splitlines(True), b.splitlines(True), "upstream/x.md", "disk/x.md"))})

SPLIT = ["", "a", "a\n", "a\nb", "a\r\nb\rc\n", "\n\n", "x\x0by\x0cz", "\x1c\x1d\x1e\x1f", "a\x85b c d", "😀\n中\r", "tail\r"]
splitlines = [{"s": s, "keep": s.splitlines(True), "drop": s.splitlines()} for s in SPLIT]

WS = [chr(c) for c in range(0x110000) if chr(c).isspace()]
NEAR = ["​", "﻿", "\x1b", "᠎", "\x00", "é"]
strip = []
for s in ["", "  a b  ", "\x1c\x1fa\x85", "﻿a﻿", "​a​", " 　x ", "".join(WS) + "mid" + "".join(WS)] + \
        ["".join(rng.choices(WS + NEAR + list("ab"), k=12)) for _ in range(20)]:
    strip.append({"s": s, "strip": s.strip(), "lstrip": s.lstrip(), "rstrip": s.rstrip(), "split": s.split()})

SORT_POOL = ["", "a", "B", "a/b", "a-b", "a b", "！", "", "�", "😀", "😀a", "\U00010000", "é", "é", "中", "~", "Z"]
sort = []
for _ in range(12):
    items = rng.sample(SORT_POOL, k=rng.randint(2, len(SORT_POOL)))
    sort.append({"items": items, "sorted": sorted(items)})

rounding = [{"x": m / n, "round": repr(round(m / n, 2))} for n in range(1, 41) for m in range(n + 1)]
rounding += [{"x": x, "round": repr(round(x, 2))} for x in (0.125, 0.375, 0.625, 0.875, 0.285, 1.005, 2.675, 0.5, 1.0)]
floats = [{"x": x, "repr": repr(x)} for x in (0.0, -0.0, 1.0, 0.5, 0.95, 1e16, 1e15, 1e-4, 1e-5, 123.456, 0.1 + 0.2,
                                               1e22, 5e-324, 1.7976931348623157e308, -2.5, 12345678901234567.0)]

JSON_TEXTS = [
    '{"b": 1, "a": [1.0, 2, -0.0, 1e5, 0.1], "10": "ten", "2": "two"}',
    '"control \\u0001 \\u001f del \\u007f tab\\t nl\\n quote\\" backslash\\\\ slash\\/"',
    '"é 中 😀 \\ud83d\\ude00 lone \\ud800 nbsp \\u00a0 bom \\ufeff ls \\u2028"',
    '[]', '{}', '[[], {}, [[]], {"x": {}}]', 'null', 'true', '[true, false, null]',
    '{"dup": 1, "other": 2, "dup": 3}', '[NaN, Infinity, -Infinity]', '1.5e300', '-0', '0.0001', '1e-05',
    '{"nested": {"list": [1, [2, [3, {"deep": "é"}]]], "empty": ""}}',
    '{"upstreams": {"pstack": {"commit": "101b274", "tree": "54ac526"}}, "applied": 186, "similarity": 0.9}',
]
json_cases = [{"text": t, "dumps": json.dumps(json.loads(t)), "indent": json.dumps(json.loads(t), indent=2),
               "str": str(json.loads(t))} for t in JSON_TEXTS]

REPR = ["", "plain", "it's", 'say "hi"', "both ' and \"", "back\\slash", "tab\tnl\nret\r", "\x00\x1f\x7f",
        "é中😀", "\xa0​ ́\x85", "\U000e0001 tag", "﻿", "\U0010ffff"]
reprs = [{"s": s, "repr": repr(s)} for s in REPR]

replaces = [{"s": s, "old": o, "new": n, "out": s.replace(o, n)} for s, o, n in
            [("abc", "", "-"), ("", "", "x"), ("a😀b", "", "|"), ("aaa", "a", "$&"), ("x{{a}}y{{a}}", "{{a}}", "v"), ("abc", "z", "y")]]

quotes = [{"s": s, "out": shlex.quote(s)} for s in ["", "plain", "a b", "it's", "@%+=:,./-_", "é", "$HOME", "-y"]]

out = {"matcher": matcher, "unified": unified, "splitlines": splitlines, "strip": strip, "sort": sort,
       "round": rounding, "floats": floats, "json": json_cases, "repr": reprs, "replace": replaces, "quote": quotes}
path = Path(__file__).with_name("cpython.json")
path.write_text(json.dumps(out, separators=(",", ":")) + "\n")
print(f"wrote {path} ({path.stat().st_size // 1024} KB, {len(matcher)} matcher cases)")
