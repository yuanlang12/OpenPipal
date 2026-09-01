"""挑出**不用 Docker 也能忠实复现**的题：Python 小版本能对上、且不需要编译扩展。

排除的：sphinx（tox 套娃）、matplotlib/scikit-learn/astropy/seaborn（要编 C/Cython，
老版本在 arm64 上编不动）。django 3.0-3.2 官方钉 py3.6，uv 在 arm64 上没有 3.6，
换 3.8 会有几条 cookie 测试天生红——留给第二批，用 baseline 扣除法处理。
"""
import os as _os
# 题库、仓库快照、venv 住 scratch（默认 ~/openpipal-bench/swebench）；脚本住仓库。别改回 /tmp（开机会被清）。
# 刻意分开：脚本要进版本管理，几十 GB 的快照和 venv 不能进。
BENCH_ROOT = _os.getenv("BENCH_SCRATCH") or _os.path.expanduser("~/openpipal-bench/swebench")
def P(*parts):
    """拼一个 scratch 下的路径"""
    return _os.path.join(BENCH_ROOT, *parts)
import json, collections
ALLOW = {  # (repo, version) -> python，只收官方规格里的 python 能被 uv 提供的
    "django/django": {"4.0": "3.8", "4.1": "3.9", "4.2": "3.9", "5.0": "3.11"},
    "sympy/sympy": "3.9", "pytest-dev/pytest": "3.9", "pylint-dev/pylint": "3.9",
    "psf/requests": "3.9", "pallets/flask": "3.11", "pydata/xarray": "3.10",
}
def build():
    rows = json.load(open(P("verified.json")))
    out = []
    for r in rows:
        a = ALLOW.get(r["repo"])
        if a is None: continue
        py = a.get(r["version"]) if isinstance(a, dict) else a
        if not py: continue
        out.append({"iid": r["instance_id"], "repo": r["repo"], "version": r["version"],
                    "py": py, "difficulty": r["difficulty"]})
    return out
if __name__ == "__main__":
    c = build()
    print("总数", len(c))
    for k, v in collections.Counter(x["repo"] for x in c).most_common():
        print(f"  {v:4} {k}")
    print("按难度:", dict(collections.Counter(x["difficulty"] for x in c)))
    json.dump(c, open(P("corpus.json"), "w"))
