# Verification

## Gates

```bash
.agents/scripts/check.sh
node common/scripts/install-run-rush.js build
node common/scripts/install-run-rush.js lint
node common/scripts/install-run-rush.js test
node common/scripts/install-run-rush.js typecheck:tests
```

`check.sh` reported `Task records OK: 36 checked` and
`KB OK (238 files reachable from root.md)`. Both counts are past tense on
purpose: the file count moves whenever anyone adds a knowledge-base page, so it
records what this run saw rather than a claim about the tree today. All four
Rush gates were invoked and reported no `FAILURE` operation; no package source changed in this task, so
`rush build` is a cache hit.

One macOS CI leg failed once on `tests/scheduler-cron.test.ts`, a
timing-sensitive assertion unrelated to this change: every file this branch
touches is under `.agents/`, and the same commit passed on rerun and on the
ubuntu leg throughout.

## Behavior probes

The checker's rules are exercised by mutating a real record, running the
checker, and restoring the file. Each probe states the exit code it must
produce. Run from the repository root:

````python
import pathlib, subprocess

CHECK = ['python3', '.agents/skills/dev-workflow/scripts/init_task.py', 'check-all']
record = pathlib.Path('.agents/tasks/channel/redact-tool-call-arguments/README.md')
index = pathlib.Path('.agents/tasks/channel/README.md')
base_record, base_index = record.read_text(), index.read_text()

def probe(name, text, index_text, expect):
    record.write_text(text)
    index.write_text(index_text)
    code = subprocess.run(CHECK, capture_output=True, text=True).returncode
    record.write_text(base_record)
    index.write_text(base_index)
    print(('PASS' if code == expect else 'FAIL'), f'exit={code}', name)

r, i = base_record, base_index
probe('a clean tree passes', r, i, 0)
probe('a mid-workflow state is rejected',
      r.replace('- State: `done`', '- State: `review`'), i, 1)
probe('prose after the state is rejected',
      r.replace('- State: `done`', '- State: `done` — CI green'), i, 1)
probe('a body heading `## Tasks completed` no longer exempts the record',
      r.replace('- State: `done`', '- State: `review`')
       .replace('## Delivery', '## Tasks completed\n\n- x\n\n## Delivery'), i, 1)
probe('a file carrying both heading kinds is refused',
      r.replace('## Delivery', '## Tasks\n\n- x\n\n## Delivery'), i, 1)
probe('a fenced `## Tasks` is inert',
      r.replace('## Delivery', '## Delivery\n\n```markdown\n## Tasks\n```\n', 1), i, 0)
probe('a `- CI:` label is rejected',
      r.replace('- Blockers: None.', '- CI: green.\n- Blockers: None.'), i, 1)
probe('a `- Merge:` label is rejected',
      r.replace('- Blockers: None.', '- Merge: pending.\n- Blockers: None.'), i, 1)
probe('a `- Branch:` label is rejected',
      r.replace('- Blockers: None.', '- Branch: `x`.\n- Blockers: None.'), i, 1)
probe('a `- Current repair branch:` label is rejected',
      r.replace('- Blockers: None.', '- Current repair branch: `x`.\n- Blockers: None.'), i, 1)
probe('a fenced `- CI:` is allowed',
      r.replace('- Blockers: None.',
                '- Blockers: None.\n\n```text\n- CI: green\n```\n'), i, 0)
probe('a `- CI:` under `## Historical` is allowed',
      r + '\n## Historical round 1\n\n- CI: green.\n', i, 0)
probe('`## Historically speaking` does not claim the frozen exemption',
      r + '\n## Historically speaking, this was hard\n\n- CI: green.\n', i, 1)
probe('an index entry repeating a state is rejected', r,
      i.replace('](/.agents/tasks/channel/redact-tool-call-arguments/README.md) — ',
                '](/.agents/tasks/channel/redact-tool-call-arguments/README.md) — `done`: '), 1)
````

All fourteen probes report `PASS`.

Two of them pin bugs this task shipped and then had to fix, so they are the ones
to keep if the set is ever trimmed:

- `## Tasks completed` — the first version matched headings as substrings, so a
  record containing that phrase was read as a domain index, checked far more
  loosely, and passed with `State: review` and exit code 0.
- `## Historically speaking` — the frozen-section exemption was a prefix test,
  so any heading starting with those letters exempted everything after it.

Both are the same failure: an exemption a passing phrase can claim by accident.

## Counts

The record counts in the design and the pull request description are measured
by running the gate against `27428f85`, the trunk commit this task was measured
on. The commit is named rather than written as `origin/next`, which stops
meaning the pre-change trunk the moment this merges. It reports 7
state-rejected, 23 label-rejected, and 23 in the union, the seven being a
subset:

```python
import subprocess, sys
sys.dont_write_bytecode = True  # a .pyc here embeds an absolute path and cannot be committed
sys.path.insert(0, '.agents/skills/dev-workflow/scripts')
import init_task as gate

state, label = set(), set()
for path in subprocess.run(
        ['git', 'ls-tree', '-r', '--name-only', '27428f85', '.agents/tasks'],
        capture_output=True, text=True).stdout.split():
    if not path.endswith('README.md'):
        continue
    text = subprocess.run(['git', 'show', f'27428f85:{path}'],
                          capture_output=True, text=True).stdout
    if gate.is_domain_index(path, text):
        continue
    for bucket, check in ((state, lambda: gate.check_state(text, path, False)),
                          (label, lambda: gate.check_delivery_labels(path, gate.live_lines(text)))):
        try:
            check()
        except Exception:
            bucket.add(path)
print(len(state), len(label), len(state | label))
```

The twenty-fourth corrected record, `teamwork-teammates-are-not-subagents`, is
absent from both sets on purpose: its stale text sat inside `- Next action:` and
`- Pull request:`, labels that are not banned. It is the worked example of the
residual gap §8 admits, and it is why the gate's output is not reported as proof
that the tree is clean.

The claim that about 140 distinct bullet labels are in use is reproduced with
the gate's own rule, over its own definition of a live line. The design doc
rounds the figure because an exact count expires on the next record edit — which
is the rule this task exists to enforce, and which it demonstrated on itself:
the block read 141, then 139, then 137 over the course of this task, each drop
caused by correcting a record. Run it for the current number:

```python
import pathlib, sys
sys.dont_write_bytecode = True  # a .pyc here embeds an absolute path and cannot be committed
sys.path.insert(0, '.agents/skills/dev-workflow/scripts')
import init_task as gate

labels = set()
for path in pathlib.Path('.agents/tasks').rglob('README.md'):
    text = path.read_text()
    if gate.is_domain_index(str(path), text):
        continue
    for line in gate.live_lines(text):
        match = gate.LABEL_RE.match(line)
        if match:
            labels.add(match.group(1))
print(len(labels))
```
