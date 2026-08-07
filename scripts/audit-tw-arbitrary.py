"""审计：Tailwind 任意值工具类是否真的生成到产物 CSS。

Tailwind v4 会静默丢弃它无法归类的任意值（例如 border-[1.5px] 被当成颜色候选），
本项目又刻意不引 Preflight，丢弃后会退化成浏览器默认样式且无任何报错。
本脚本把源码里出现的所有含任意值的候选类，逐条与 dist 产物 CSS 比对。

用法：先 `npx vite build --mode web --emptyOutDir false`，再
      python scripts/audit-tw-arbitrary.py [额外扫描目录...]
"""

import glob
import os
import re
import sys

SPECIAL = set(".[](){}:/%,=!#*+>~&$'\"@|^")


def escape_selector(token: str) -> str:
    return "".join("\\" + ch if ch in SPECIAL else ch for ch in token)


def strip_comments(src: str) -> str:
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    src = re.sub(r"^\s*//.*$", "", src, flags=re.M)
    return src


def main() -> int:
    css_files = glob.glob("dist/web/assets/*.css")
    if not css_files:
        print("找不到 dist/web/assets/*.css，请先构建。")
        return 2
    css = open(max(css_files, key=os.path.getsize), encoding="utf-8").read()

    roots = sys.argv[1:] or [
        "src/apps/answer-card/client/components/ui/v2",
        "src/apps/answer-card/client/dev",
    ]
    files: list[str] = []
    for root in roots:
        files.extend(sorted(glob.glob(os.path.join(root, "**", "*.tsx"), recursive=True)))

    candidates: dict[str, str] = {}
    for path in files:
        src = strip_comments(open(path, encoding="utf-8").read())
        for literal in re.findall(r'"([^"\n]*)"', src):
            for token in literal.split():
                if ("[" in token or "(--" in token) and re.match(r"^[a-z\[]", token):
                    candidates.setdefault(token, path)

    missing = [
        (tok, src)
        for tok, src in sorted(candidates.items())
        if "." + escape_selector(tok) not in css
    ]

    print(f"扫描 {len(files)} 个文件，任意值候选 {len(candidates)} 个，未命中 {len(missing)} 个")
    for tok, src in missing:
        print(f"  MISS {tok}    <- {src}")
    return 1 if missing else 0


if __name__ == "__main__":
    raise SystemExit(main())
