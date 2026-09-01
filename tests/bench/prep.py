"""把一道题准备成可跑的样子，并量出 baseline（未改动时哪些测试就已经是红的）。

为什么要 baseline：官方环境是 Docker 镜像钉死的，这里换成 uv venv，Python 小版本对不上时
会有少量 P2P 天生就红（实测 django 3.0 在 py3.8 上 6 条 cookie 测试因 http.cookies 行为变更而红）。
判分时把这些先扣掉，判据变成「F2P 全绿 且 P2P 不比 baseline 更差」——两条臂共用同一份
baseline，差值不受影响。
"""
import os as _os
# 题库、仓库快照、venv 住 scratch（默认 ~/openpipal-bench/swebench）；脚本住仓库。别改回 /tmp（开机会被清）。
# 刻意分开：脚本要进版本管理，几十 GB 的快照和 venv 不能进。
BENCH_ROOT = _os.getenv("BENCH_SCRATCH") or _os.path.expanduser("~/openpipal-bench/swebench")
def P(*parts):
    """拼一个 scratch 下的路径"""
    return _os.path.join(BENCH_ROOT, *parts)
import json, os, shutil, subprocess, sys, time
sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
import swb
from grade import grade

ROOT = BENCH_ROOT
REPO_DIR = {"django/django": "src/django", "sympy/sympy": "src/sympy",
            "psf/requests": "src/requests", "pytest-dev/pytest": "src/pytest",
            "pylint-dev/pylint": "src/pylint", "pallets/flask": "src/flask",
            "pydata/xarray": "src/xarray"}

def sh(cmd, cwd=None, env=None, timeout=1800):
    p = subprocess.run(["bash", "-lc", cmd], cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout + p.stderr

def instance(iid):
    return [r for r in json.load(open(f"{ROOT}/verified.json")) if r["instance_id"] == iid][0]

def ensure_clone(inst):
    d = os.path.join(ROOT, REPO_DIR[inst["repo"]])
    if not os.path.isdir(d):
        os.makedirs(os.path.dirname(d), exist_ok=True)
        c, o = sh(f"git clone --filter=blob:none -q https://github.com/{inst['repo']}.git {d}")
        assert c == 0, o
    return d

def snapshot(inst, dest):
    """只留 base_commit 那一刻的工作树，.git 重建成单条提交 —— 未来历史（含标准答案）不在磁盘上。"""
    src = ensure_clone(inst)
    sh(f"git -C {src} cat-file -e {inst['base_commit']} || git -C {src} fetch -q origin {inst['base_commit']}")
    shutil.rmtree(dest, ignore_errors=True); os.makedirs(dest)
    c, o = sh(f"git -C {src} archive {inst['base_commit']} | tar -x -C {dest}")
    assert c == 0, o
    for cmd in ["git init -q -b main .", "git config --local user.email b@openpipal.local",
                "git config --local user.name Bench",
                # 每建一个快照仓库 git 都会顺手 auto-gc/repack —— 8 路并行时那些 repack
                # 把 CPU 全占了，快照本身反而排队。快照是一次性的，压根不需要维护。
                "git config --local gc.auto 0",
                "git config --local maintenance.auto false",
                # 快照是一次性的、只活到这道题跑完，没必要为它做 zlib 压缩。
                # 实测 8 路并行时 `git commit` 单条要 20s+ 且全卡在压缩上（django 树 7000+ 文件）。
                "git config --local core.compression 0",
                "git config --local core.looseCompression 0",
                "git config --local pack.compression 0",
                "printf '.venv/\\n' > .git/info/exclude",
                "git add -A", f"git commit -q -m 'snapshot @ {inst['base_commit'][:10]}'"]:
        c, o = sh(cmd, cwd=dest); assert c == 0, f"{cmd}: {o}"

def build_env(inst, work, py):
    sp = swb.spec(inst)
    c, o = sh(f"uv venv .venv --python {py} -q", cwd=work); assert c == 0, o
    # 快照把 .git 压成单条提交、没有 tag，setuptools_scm 于是把版本算成 0.1.dev1 ——
    # pytest 自己的 pyproject.toml 里有 minversion 检查，会因此整个跑不起来（实测 10081）。
    # 用数据集里的 version 假装一下，既保住"未来历史不在磁盘上"的反作弊性质，又让装得上。
    env = dict(os.environ, VIRTUAL_ENV=os.path.join(work, ".venv"),
               PATH=os.path.join(work, ".venv/bin") + ":" + os.environ["PATH"],
               SETUPTOOLS_SCM_PRETEND_VERSION=str(inst["version"]) + ".0")
    extra = " ".join(sp.get("pip_packages", []))
    pkgs = sp.get("packages", "")
    if pkgs and pkgs not in ("requirements.txt", "environment.yml"):
        extra += " " + pkgs
    if extra.strip():
        c, o = sh(f"uv pip install -q {extra}", cwd=work, env=env)
        if c: return False, "pip_packages 装不上: " + o[-500:]
    c, o = sh("uv pip install -q -e .", cwd=work, env=env)
    if c: return False, "install 失败: " + o[-800:]

    # 规格表里 packages="requirements.txt" / "environment.yml" 的仓库，官方镜像是从仓库自带的
    # 依赖清单里装的；我们跳过了那一步，于是 **pytest 根本没进 venv**——test_cmd 一跑就
    # `No module named pytest`，解析器一条结果都拿不到，判分恒为假且不报错（pylint 9 道、
    # flask 1 道就是这么全灭的）。这里补齐：优先用仓库自己的测试依赖清单（版本钉在那儿），
    # 没有就装一个通用 pytest。
    if "pytest" in sp.get("test_cmd", ""):
        have = sh('python -c "import pytest"', cwd=work, env=env)[0] == 0
        if not have:
            for name in ("requirements_test_min.txt", "requirements_test.txt", "requirements-dev.txt"):
                if os.path.exists(os.path.join(work, name)):
                    sh(f"uv pip install -q -r {name}", cwd=work, env=env)
            if sh('python -c "import pytest"', cwd=work, env=env)[0] != 0:
                c, o = sh("uv pip install -q pytest", cwd=work, env=env)
                if c: return False, "pytest 装不上: " + o[-400:]
    return True, ""

def prepare(iid, py):
    inst = instance(iid)
    work = os.path.join(ROOT, "work", iid)
    t0 = time.time()
    snapshot(inst, work)
    ok, err = build_env(inst, work, py)
    if not ok: return {"iid": iid, "ok": False, "why": err}
    t1 = time.time()
    open(os.path.join(ROOT, "work", iid + ".test_patch"), "w").write(inst["test_patch"])
    c, o = sh(f"git apply {ROOT}/work/{iid}.test_patch", cwd=work)
    if c: return {"iid": iid, "ok": False, "why": "test_patch 打不上: " + o[-300:]}
    g = grade(inst, work)
    sh("git checkout -q -- . && git clean -qfd -e .venv", cwd=work)
    return {"iid": iid, "ok": True, "py": py, "env_s": round(t1 - t0, 1), "grade_s": round(time.time() - t1, 1),
            "f2p": g["f2p"][:2], "p2p": g["p2p"][:2], "p2p_bad": g["p2p"][2], "parsed": g["parsed"]}

if __name__ == "__main__":
    for arg in sys.argv[1:]:
        iid, py = arg.split("@")
        try:
            r = prepare(iid, py)
        except Exception as e:
            r = {"iid": iid, "ok": False, "why": f"{type(e).__name__}: {e}"}
        print(json.dumps(r, ensure_ascii=False))
