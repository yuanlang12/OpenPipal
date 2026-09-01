"""SWE-bench 的三样东西，脱开它的 Docker 单独用：规格表、测试指令、日志解析。

- 规格表在 v2 的 constants.py 里是个平铺 dict（v5 挪进了数据集/镜像层，反而不好取），
  用 importlib 直接按文件加载，绕开 `swebench/__init__.py`（它 import modal 会炸）。
- 解析器用 v5 的 MAP_REPO_TO_PARSER_PY。
- get_test_directives 是纯函数，二十行，照 v2 的实现抄过来，省得为它再装一套。
"""
import os as _os
# 题库、仓库快照、venv 住 scratch（默认 ~/openpipal-bench/swebench）；脚本住仓库。别改回 /tmp（开机会被清）。
# 刻意分开：脚本要进版本管理，几十 GB 的快照和 venv 不能进。
BENCH_ROOT = _os.getenv("BENCH_SCRATCH") or _os.path.expanduser("~/openpipal-bench/swebench")
def P(*parts):
    """拼一个 scratch 下的路径"""
    return _os.path.join(BENCH_ROOT, *parts)
import importlib.util, json, os, re, subprocess, sys

NON_TEST_EXTS = [".json", ".png", "csv", ".txt", ".md", ".jpg", ".jpeg", ".pkl",
                 ".yml", ".yaml", ".toml"]

def _load(name, path):
    s = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(s); sys.modules[name] = m; s.loader.exec_module(m)
    return m

_C = _load("swb_v2_const", P(".specs/lib/python3.11/site-packages/swebench/harness/constants.py"))
SPECS = _C.MAP_REPO_VERSION_TO_SPECS

def parsers():
    sys.path.insert(0, P(".tools/lib/python3.12/site-packages"))
    from swebench.harness.log_parsers.python import MAP_REPO_TO_PARSER_PY
    return MAP_REPO_TO_PARSER_PY

def test_directives(inst):
    ds = re.findall(r"diff --git a/.* b/(.*)", inst["test_patch"])
    ds = [d for d in ds if not any(d.endswith(e) for e in NON_TEST_EXTS)]
    if inst["repo"] == "django/django":
        out = []
        for d in ds:
            d = d[:-3] if d.endswith(".py") else d
            d = d[len("tests/"):] if d.startswith("tests/") else d
            out.append(d.replace("/", "."))
        ds = out
    return ds

def spec(inst):
    return SPECS[inst["repo"]][inst["version"]]
