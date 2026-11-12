# Verification

## Gates

```bash
.agents/scripts/check.sh
node common/scripts/install-run-rush.js build
node common/scripts/install-run-rush.js lint
node common/scripts/install-run-rush.js test
node common/scripts/install-run-rush.js typecheck:tests
```

`check.sh` reported `Task records OK: 45 checked` and
`KB OK (278 files reachable from root.md)`, both in the author's shallow clone
and with a full clone's objects added through `GIT_ALTERNATE_OBJECT_DIRECTORIES`.
The counts record what that run saw. All four Rush gates reported no `FAILURE`
operation; no package source changed, so `rush build` skipped every operation
as a cache hit.

## Behavior probes

Each probe writes a file into a temporary task tree inside the repository and
asks `commit_citations` whether it cites a commit. Hashes are taken from the
checkout at run time, so the script itself cites none. The last two probes run
`check-all` as a subprocess against a throwaway repository. Run from the
repository root; `GATE_DIR` exists for the mutation runner below.

```python
import hashlib, os, subprocess, sys, tempfile
from pathlib import Path
sys.dont_write_bytecode = True
sys.path.insert(0, os.environ.get('GATE_DIR', '.agents/skills/dev-workflow/scripts'))
import init_task as gate

root = Path('.').resolve()
def git(*args, cwd=root):
    return subprocess.run(['git', *args], cwd=cwd, capture_output=True, text=True, check=True).stdout.strip()

commit = git('rev-parse', 'HEAD')
digest = hashlib.sha256(b'probe').hexdigest()
missing = next(h for i in range(100) if (h := hashlib.sha1(f'probe{i}'.encode()).hexdigest()[:12])
               and subprocess.run(['git', 'cat-file', '-e', h], cwd=root, capture_output=True).returncode != 0)

def cited(files):
    with tempfile.TemporaryDirectory(dir=root, prefix='.probe-') as tmp:
        for name, text in files.items():
            path = Path(tmp) / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding='utf-8')
        return gate.commit_citations(root, Path(tmp))

results = []
def probe(name, files, expect_rejected):
    got = bool(cited(files))
    results.append((name, got == expect_rejected))

probe('short hash in a README is rejected', {'README.md': f'Measured at `{commit[:8]}`.\n'}, True)
probe('full hash in verification.md is rejected', {'verification.md': f'head {commit}\n'}, True)
probe('upper-case hash is rejected', {'README.md': f'at {commit[:10].upper()}\n'}, True)
probe('64-digit digest passes', {'README.md': f'sha256 {digest}\n'}, False)
probe('hex that names no object passes', {'README.md': f'id {missing}\n'}, False)
probe('a blob hash passes', {'README.md': f'blob {git("rev-parse", "HEAD:README.md")[:12]}\n'}, False)
probe('hash inside a fenced script is rejected', {'verification.md': f'```python\nbase = "{commit[:8]}"\n```\n'}, True)
probe('hash under ## Historical passes', {'README.md': f'## Historical rounds\n\nhead {commit[:8]}\n'}, False)
probe('## Historically does not freeze', {'README.md': f'## Historically speaking\n\nhead {commit[:8]}\n'}, True)
probe('a fenced ## Historical freezes nothing', {'README.md': f'```text\n## Historical\n```\n\nhead {commit[:8]}\n'}, True)
probe('a later ## heading ends the frozen section', {'README.md': f'## Historical rounds\n\nold\n\n## Delivery\n\nhead {commit[:8]}\n'}, True)
probe('hex glued to letters passes', {'README.md': f'v{commit[:8]}x\n'}, False)
probe('a nested domain index is scanned too', {'child/README.md': '- [x]' f'(y) — at {commit[:8]}\n'}, True)

def old_unfenced(text):
    lines, fenced = [], False
    for line in text.splitlines():
        if line.startswith('```'):
            fenced = not fenced
            continue
        if not fenced:
            lines.append(line)
    return lines
def old_live(text):
    lines, frozen = [], False
    for line in old_unfenced(text):
        if line.startswith('## '):
            frozen = gate.FROZEN_SECTION_RE.match(line) is not None
        if not frozen:
            lines.append(line)
    return lines
texts = [p.read_text(encoding='utf-8') for p in sorted((root / '.agents/tasks').rglob('*.md'))]
results.append((f'live_lines/unfenced_lines unchanged over {len(texts)} task files',
                all(gate.live_lines(t) == old_live(t) and gate.unfenced_lines(t) == old_unfenced(t) for t in texts)))

with tempfile.TemporaryDirectory() as tmp:
    repo = Path(tmp)
    git('init', '-q', cwd=repo)
    git('-c', 'user.name=probe', '-c', 'user.email=probe@example.com', 'commit', '-q', '--allow-empty', '-m', 'probe', cwd=repo)
    head = git('rev-parse', 'HEAD', cwd=repo)
    tasks = repo / '.agents/tasks'
    (tasks / 'd/do-thing').mkdir(parents=True)
    # Link syntax is split so that check.sh's link check does not read these as links.
    (tasks / 'README.md').write_text('# Tasks\n\n## Child Scopes\n\n- [d]' '(/.agents/tasks/d/README.md)\n')
    (tasks / 'd/README.md').write_text('# D\n\n## Tasks\n\n- [Do thing]' '(/.agents/tasks/d/do-thing/README.md) — goal\n')
    (tasks / 'd/do-thing/README.md').write_text(
        '# Do thing\n\n## Current state\n\n- Goal: goal\n- State: `done`\n'
        '- Requirement: [r]' '(/.agents/tasks/d/do-thing/requirement.md)\n')
    (tasks / 'd/do-thing/requirement.md').write_text(f'Measured at `{head[:8]}`.\n')
    def run(*extra):
        return subprocess.run([sys.executable, gate.__file__,
                               'check-all', '--repo-root', str(repo), *extra], capture_output=True, text=True)
    strict, flight = run(), run('--allow-in-flight')
    results.append(('check-all fails on a cited commit, naming file and line',
                    strict.returncode == 1 and '.agents/tasks/d/do-thing/requirement.md:1: cites commit' in strict.stderr))
    results.append(('check-all --allow-in-flight skips the commit rule', flight.returncode == 0))

for name, ok in results:
    print(('PASS' if ok else 'FAIL'), name)
print(sum(ok for _, ok in results), 'of', len(results), 'passed')
```

All sixteen probes report `PASS`. The fourteenth checks the refactor underneath
the rule: the label rule's two line filters now read the same
`classified_lines` pass as the commit rule, and they return what the previous
implementation returned for every Markdown file in the task tree.

As with #413's probes, nothing runs these but a person: `check.sh` runs the
gate over the tree, never the gate's rules against themselves.

## Mutation matrix

A probe set that passes proves nothing about the probes. Each mutation below
breaks one decision in `init_task.py`, and the probes run against the mutated
copy. Save the probe script above as `probes.py` and run from the repository
root:

```python
import os, subprocess, sys, tempfile
from pathlib import Path
src = Path('.agents/skills/dev-workflow/scripts/init_task.py').read_text()
MUTATIONS = {
    'fenced lines skipped': ('for number, line, _, frozen in classified_lines(read(path)):\n            if not frozen:',
                             'for number, line, fenced, frozen in classified_lines(read(path)):\n            if not frozen and not fenced:'),
    'frozen heading matched as a prefix': ('r"^## Historical\\b"', 'r"^## Historical"'),
    'any existing object counts': ('result.endswith(" commit")', 'not result.endswith(" missing")'),
    '--allow-in-flight ignored': ('if not args.allow_in_flight:\n        failures.extend(commit_citations', 'if True:\n        failures.extend(commit_citations'),
    'README files only': ('if not path.is_file():\n            continue\n        relative', 'if not path.is_file() or path.name != "README.md":\n            continue\n        relative'),
    'no word boundary': ('r"(?<![0-9A-Za-z])[0-9A-Fa-f]{7,40}(?![0-9A-Za-z])"', 'r"[0-9A-Fa-f]{7,40}"'),
    'rule not wired into check-all': ('failures.extend(commit_citations(root, tasks))', 'pass'),
}
for name, (old, new) in MUTATIONS.items():
    assert src.count(old) == 1, name
    with tempfile.TemporaryDirectory() as tmp:
        (Path(tmp) / 'init_task.py').write_text(src.replace(old, new))
        out = subprocess.run([sys.executable, 'probes.py'], env={**os.environ, 'GATE_DIR': tmp},
                             capture_output=True, text=True).stdout
        failed = [l[5:] for l in out.splitlines() if l.startswith('FAIL')]
        print(f'{name}: ' + ('; '.join(failed) if failed else 'NOT CAUGHT'))
```

| Mutation | Probes that fail |
| --- | --- |
| Fenced lines skipped | hash inside a fenced script |
| Frozen heading matched as a prefix | `## Historically` does not freeze |
| Any existing object counts, not only a commit | a blob hash passes |
| `--allow-in-flight` ignored | `check-all --allow-in-flight` skips the commit rule |
| README files only | full hash in `verification.md`; hash inside a fenced script; `check-all` fails on a cited commit |
| No word boundary around the candidate | hex glued to letters passes |
| Rule not wired into `check-all` | `check-all` fails on a cited commit |

Every mutation is caught.

## The rewrite

### Before and after

Measured with the rule itself, over `.agents/tasks/` as it stood on `next` after
#439 merged and over the working tree after the rewrite, both resolved against a
clone holding full history and every `refs/pull/*/head` (pass it through
`GIT_ALTERNATE_OBJECT_DIRECTORIES` when the checkout is shallow):

```python
import subprocess, sys, tempfile
from pathlib import Path
sys.dont_write_bytecode = True
sys.path.insert(0, '.agents/skills/dev-workflow/scripts')
import init_task as gate

root = Path('.').resolve()
base = subprocess.run(['gh', 'pr', 'view', '439', '--json', 'mergeCommit', '--jq', '.mergeCommit.oid'],
                      capture_output=True, text=True, check=True).stdout.strip()
with tempfile.TemporaryDirectory(dir=root, prefix='.probe-') as tmp:
    subprocess.run(f'git archive {base} .agents/tasks | tar -x -C {tmp}', shell=True, check=True)
    before = gate.commit_citations(root, Path(tmp) / '.agents/tasks')
after = gate.commit_citations(root, root / '.agents/tasks')
tokens = sum(len(f.split(': cites commit ')[1].split('. Cite')[0].split(', ')) for f in before)
files = {f.split(':')[0].split('.agents/tasks/')[1] for f in before}
print('before:', len(before), 'lines,', tokens, 'citations,', len(files), 'files; after:', len(after), 'lines')
```

It reported 167 lines, 188 citations, and 77 files before; 0 lines after. The
77 files are exactly the ones the rewrite changed, besides the scope index
entry for this task.

### How it ran

As #413's did, with one node per file for the first two stages:

- **Rewrite (Sonnet).** Each node looked up every hash its file cited — which
  pull request carried it, whether it was a merge on `next`, whether a review or
  Actions run recorded it as a head — and rewrote the citation under the
  instructions in [§5 of the design](/.agents/tasks/architecture/gate-commit-references-in-task-records/technical-design/final.md).
- **Re-check (Sonnet).** A second node per file read the diff against fresh
  lookups. It passed 68 files and corrected 9, mostly wording the rewrite had
  changed beyond the citation and a reflow wider than the edit.
- **Close-out (Opus).** One node reviewed the whole diff and corrected eleven
  more: a claim that a CI run was a pull request's first when it was not, an
  anchor that read as if #378 had changed a file it had not touched, lost
  antecedents ("that pushed head"), a "merged onto" turned into "measured
  against", a 13-line reflow for one token, and wording that disagreed between
  files of the same task.

### Checked after the close-out

- **Every review and run named on a changed line is the head that was cited.**
  The rewritten lines carry 25 distinct review and Actions run identifiers, some
  of which the original lines already named. Each was looked up on GitHub, and
  each one's recorded head (`commit_id` for a review, `head_sha` for a run) is a
  commit that the same file's removed lines cited.
- **#413's counting script** resolves its baseline from #412's merge at run time
  and still prints `7 23 23`.
- **Operator quotes.** Searched as changed lines containing Chinese text, the
  language the operator's quotes are in: one line matched, and its quote is
  byte-identical before and after.
- **No escape into the frozen exemption.** No `## Historical …` heading was
  added or removed.
- **No banned label added.** Of the seven changed `- Baseline:` lines, four
  keep the label with the hash replaced and three were reworded; none is in a
  README, where the label rule applies.

## Limits

These describe what the method does not see; they are not a claim the tree is
otherwise complete.

- **A hash inside a longer token is not a candidate.** The alpha release
  workflow names a prerelease `alpha.g` followed by a commit prefix, and six
  such versions appear in four records. The word boundary, copied from
  upstream, skips them. They were left as written: each is the version npm
  published the package under, and all six were still published on the public
  registry on 2026-09-17.
- **An object the checkout lacks cannot match.** CI sees every pushed head. A
  commit that was never pushed is visible only in the checkout that made it,
  which is why knowledge closeout's own `check.sh` run matters.
- **Review input digests were not recomputed.**
  `channel/simplify-feishu-replies` records SHA-256 digests of what its reviewers
  read. The rewrite changed some of those files, but the digests describe the
  review input, not the current tree: 41 of the 57 in `input-manifest.json`
  already differed from `next` before this change.
