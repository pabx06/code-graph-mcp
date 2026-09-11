---
status: implemented
revision: 4
---

# D#24 — a new same-name definition never reaches an untouched bare caller

## Goal

An incremental run that introduces a second definition of a name must produce the
same edge set as a rebuild of the same tree. Today it does not: the new
definition is invisible to bare-name callers in files the run never opened.

## The defect, reproduced

Found 2026-09-08 while adding scope-completeness tests for CORE-06; pinned with a
failing test 2026-09-11 (this document). Tree at `cd6941e`.

```
src/a.py   def helper(): pass
src/b.py   def caller(): helper()        # bare call, fans out to every same-name def
src/c.py   def helper(): pass            # appears in the incremental run
```

A rebuild of the final tree carries **both** `b.py:caller -> a.py:helper` and
`b.py:caller -> c.py:helper`. The incremental run that added `c.py` carries only
the first. Observed:

```
a file appearing with a duplicate name must reach the bare-name callers of that
name; the incremental index under-reports the caller until b.py is next touched:
[("src/b.py:caller", "calls", "src/a.py:helper", "ambiguous")]
```

Note what is already correct: the surviving edge **is** relabelled `ambiguous`.
The post-passes do their job — they relabel edges that exist. Nothing creates the
edge that should now exist.

**Not a `PostPassScope` regression.** The original note records it reproducing
unchanged with `SCOPED_POST_PASS_MAX_FILES` forced to 0 (always `Global`), so it
predates the v0.143.0 scoped optimisation.

**User-visible.** `callgraph` and `impact` under-report a caller until the
caller's own file is next touched, and nothing prompts that.

## Constraints

- **Re-extraction is the only faithful mechanism.** The Phase 0-pre block in
  `index_files.rs` (~:1946) settles this, and it was written after PIPE-02 cost a
  permanent, self-reinforcing divergence: *"Re-extraction is the only mechanism
  that reproduces extraction's own shape, and it is correct in BOTH directions
  because it is the same code path a full rebuild runs."*
- Therefore **do not** fix this with a post-pass that inserts the missing edge.
  That arm would have to re-derive bare-call fan-out outside extraction, and it
  would have to reproduce `refine_ambiguous_targets`' proximity narrowing
  (`test_js_same_name_cross_file_prefers_closest_path`) to avoid minting edges a
  rebuild does not have. Excluded on the doctrine above, not on effort.
- The success criterion is full edge-set equality with a rebuild, not "the
  missing edge appears".

## Success criteria

1. The test in the appendix passes, including its `assert_eq!(inc, full)`.
2. `deleting_the_duplicate_puts_the_untouched_edge_back` and
   `a_third_file_reclassifies_an_edge_between_two_files_it_never_touched` stay
   green. The second one deliberately compares only the edges the incremental
   index HOLDS; once this lands, consider tightening it to full-set equality and
   deleting the comment that explains why it could not be.
3. Full suite green on both feature legs.
4. No measurable regression on the interactive path that v0.143.0 bought
   (one-file edit on django, 513 ms). The discovery query runs per edit; the
   second extraction round must not.

## Open questions — the reason this is a spec and not a patch

Discovery is the hard half. The condition is *"this run creates a definition of a
name that already has one elsewhere"*, and it cannot be evaluated where the
existing fix hooks in:

- **Phase 0-pre is too early.** `existence_change_dependents` (`index_files.rs:942`)
  runs before the run's files are parsed, so the names they define are unknown.
  Its `appearing_file_stems` sibling works only because a module stem is derivable
  from a *path*. A name is not.
- **Pre-parsing to learn the names** would put a second parse of every changed
  file on the interactive path — the path CORE-06 just spent a release bounding.
- **After the writes the answer is already computed.**
  `scope_names_from_count_drift` (`resolve.rs:518`) builds exactly the set of
  `(name, language)` pairs whose count moved. Names whose count went UP are the
  trigger set, for free.

So the shape is: discover after the writes, then re-extract the bare-name callers
of those names in a **second `index_files` round**, driven from the caller
(`run_incremental_index_cached` / `apply_file_refreshes`) rather than by making
`index_files` re-entrant.

What makes that more than a patch: a second round re-enters Phase 0, the scope
tables, `restore_inbound_edges`, the pending sweep and the deferred pass, each of
which holds invariants keyed on "files in this run" — the `run_file_paths`
comment at `index_files.rs:~1988` is explicit that a requeue whose source file is
in the run must not happen, because that file's own batch re-extracts with fresh
node ids. Round two changes what "in this run" means. That is the review surface,
and it is the same machinery whose last two mistakes (PIPE-02, CORE-02) were both
self-reinforcing.

Also unanswered: a *changed* file can add a duplicate name too, not only an
appearing one, so the trigger should be count-drift, not file novelty. And the
inverse (a definition disappearing, leaving one) is already handled by
`deleting_the_duplicate_puts_the_untouched_edge_back` — confirm round two does
not double-handle it.

## Design (rev 2 — answers the open questions above)

Reproduced again at `cfd4aa2`; the RED is verbatim the message recorded above.

### Two `index_files` calls, not one re-entrant one

`index_files` is **not modified**. The caller (`run_incremental_index_cached`,
`apply_file_refreshes`) runs it, computes the trigger set from the committed
result, and — only when that set is non-empty — calls it a second time with the
affected caller files. Each call keeps its own consistent `run_file_paths`, so
none of the invariants rev 1 flagged (`restore_inbound_edges`, the pending
sweep, the deferred pass, Phase 0-pre) sees a set that changed underneath it.
That was rev 1's whole review surface, and this shape removes it rather than
managing it.

### Discovery, corrected against the code

Rev 1 proposed reading `scope_names_from_count_drift` (`resolve.rs:518`). Two
facts make that unusable as written, both verified at `cfd4aa2`:

1. **It only runs in the `Files` scope.** `snapshot_scope_name_counts` is inside
   the `else` branch at `index_files.rs:2031`; a run of more than
   `SCOPED_POST_PASS_MAX_FILES` (64) files takes `PostPassScope::Global` and
   never builds the table. Global does not rescue the defect either — the post
   passes relabel edges that exist, which is the same reason the bug exists at
   all. So a drift signal that lives only in the scoped branch would fix small
   runs and leave big ones diverging.
2. **Its temps are dropped before the caller sees them** (`drop_scope_temps`,
   `index_files.rs:2487`), and `cg_scope_names` is a symmetric difference — up
   OR down — where this needs UP only.

So the caller takes its own `(name, language) -> count` snapshot over the run's
paths before calling `index_files` and recounts after, keeping the names whose
count ROSE. Same technique, same reason rev 1 liked it (a count diff cannot miss
a channel the way a hand-maintained list can), moved to where it is available
regardless of scope. For a one-file interactive refresh both counts are a
single-file group-by.

### The caller set is the post pass's own verdict

The bare-name callers needing re-extraction do not have to be re-derived, which
is what rev 1 feared. Round 1's Phase 2e has already relabelled the surviving
edge `ambiguous` — rev 1 records exactly that, as the thing that is "already
correct". `CONF_CASE` (`resolve.rs:823`) assigns `ambiguous` only when the
target name's count is >1 AND the caller's file does not import that exact
target AND the edge was not bound by a type/path qualifier. That is precisely
"resolved by a bare name among same-name siblings".

Round 2's file set is therefore:

> files NOT in round 1 that hold an outgoing `calls` edge whose target name is
> in the count-rose set and whose confidence is `ambiguous`.

Import-bound and type-qualified calls are excluded by construction — they must
NOT fan out — rather than by a filter this spec would have to keep in sync with
`CONF_CASE`. Indexes exist for the join (`idx_nodes_name`,
`idx_edges_target_rel`).

### Termination

Exactly one extra round, never a loop. Round 2 re-extracts existing files whose
symbol sets it does not change, so no name's definition count can rise again —
to be asserted by a test, not assumed.

### Outcome against the success criteria (rev 3)

1. **The appendix test passes, `assert_eq!(inc, full)` included.** It is in the
   tree as `a_new_same_name_definition_reaches_an_untouched_bare_caller`.
2. **The siblings stayed green, and
   `a_third_file_reclassifies_an_edge_between_two_files_it_never_touched` was
   tightened to full-set equality**, with the comment explaining why it could not
   be deleted rather than left to rot.
3. **Full suite green**: 1,816 passed / 0 failed / 5 ignored on
   `--no-default-features`; clippy `-D warnings` clean on both feature legs.
4. **No interactive regression.** django, 3,456 files / 48k nodes / 262k edges,
   each arm against its own run's baseline: ordinary one-file edit 1,232 ms ->
   1,249 ms (median of 7, inside the baseline's own 1,155-1,355 ms spread);
   no-op incremental not slower than baseline once the empty-diff guard was
   added — without that guard it was 45% slower (110 -> 159 ms), because the
   watcher reaches this path with an empty diff constantly and the count pair
   costs six temp-table DDL statements.

**What the fix costs when it fires**: a new file defining `get_queryset` and
`as_sql` pulls 23 caller files and takes the run from 352 ms to 2,993 ms.
Measured control: re-indexing 23 ordinary django files on the UNPATCHED binary
takes 2,690 ms — so the round costs what re-extracting those files costs, with no
overhead of its own. Left uncapped deliberately; a cap would reinstate the silent
divergence in a quieter form.

**Three things this turned up that rev 2 did not predict:**

- `test_phase2c_restore_binds_only_original_target_file` **encoded the same
  divergence as its contract**, in TypeScript, asserting `caller → other.ts == 0`
  as "an edge a full rebuild never makes". Measured: a rebuild of that exact tree
  makes it. The assertion was never checked against a control.
- That test can no longer carry its own v31 #4 over-creation guard:
  `idx_edges_unique` collapses the row a wrong restore would write into the row
  the fan-out round writes correctly. The guard was re-homed to
  `restore_does_not_fan_out_to_a_same_name_sibling`, which uses an import-bound
  caller the round provably skips, and is mutation-verified — under a planted
  v31 #4 the new test fails and the old one stays green.
- The first over-firing guard was **vacuous**: it started from one definition, so
  the caller's edge was `inferred` and the `ambiguous` filter refused the round
  no matter what the counts said. Relaxing `a.cnt > COALESCE(b.cnt, 0)` to `>=`
  left it passing. Rewritten to start from two definitions, where the count is
  the only thing left holding the round back, and the mutation now kills it.

### What review found (rev 4)

Two independent reviewers, empty context, one worktree each. Verdict from both:
SHIP-WITH-FIXES. Neither could break the two-round design — the in-flight marker,
the `cg_fanout_*` / `cg_scope_*` temp namespaces, the `<external>` sentinel
lifecycle and `run_file_paths` were each attacked and held — and a 14-case
differential harness found the patched binary matching a rebuild on 13 of 14
shapes where the unpatched one diverged on 9, including the `PostPassScope::Global`
branch no unit test covers.

What they found that mattered, all repaired here:

1. **The repair was half a repair.** `classify_edge_confidence` binds its
   relation pair as `params![REL_CALLS, REL_REFERENCES, …]`, so a `references`
   edge fans out by bare name exactly as a call does — and the round filtered
   `calls` alone. 14 of 35 ambiguous edges in this repo's own index are
   `references`. This document had zero occurrences of the word. Widened, with
   both constants sourced from `domain.rs` so the set cannot drift from
   `CONF_CASE` again.
2. **The termination test was vacuous, and BOTH reviewers found it independently.**
   Its second `run_incremental_index` saw an unchanged tree, so the empty-diff
   guard skipped the round entirely; one reviewer proved it with an instrumented
   run printing `dirty_seed=0 fanout_possible=false`. It would have passed with
   the whole feature deleted. Rewritten to drive `index_files` on the caller path
   directly and assert the recount is empty — and the fixture had to be rebuilt
   twice more before the assertion could fail at all.
3. **`cg_fanout_up` dropped the language** the snapshot's own doc said was
   load-bearing, so adding a JavaScript `helper` re-extracted a Python caller.
   Correctness-neutral, pure cost and node-id churn.
4. **`<module>` entered the trigger set on every file addition** — the most
   duplicated name in any index (298 of 5,903 nodes here). Selects nothing today;
   excluded.
5. **A guard was lost without a test going red.** `cfd4aa2` re-homed two
   untouched tests onto its new meta-table check, leaving the legacy
   `schema_version == 0` verdict guarded by nothing: disabling it alone left the
   suite at 1,816/0. `inspect_refuses_a_live_index_that_has_meta_but_no_snapshot_rows`
   closes it, mutation-verified.
6. **A non-WAL db with a hot rollback journal was called corrupt.** It cannot be
   opened read-only at all, and `unwrap_or(0)` turned that into the wrong
   verdict. `inspect` now falls back to staging when the in-place probe errors.
7. Smaller: a 32-bit `usize` truncation in the header read, a `with_context` that
   demoted the actionable schema-too-new line to a `Caused by:`, a stale
   `Cargo.toml` line reference, and four comments asserting things their own code
   contradicted.

Not repaired, registered instead: an import-bound Rust call diverges
incremental-vs-rebuild (`use crate::a::widget` — the rebuild fans out, the
incremental does not). PRE-EXISTING, reproduced identically on both binaries, and
it contradicts the claim that `ambiguous` is *exactly* the affected set. Filed
rather than fixed under this change.

### Risks this carries into review

- **Interactive cost.** Criterion 4 (django one-file edit, 513 ms). The
  discovery counts run every incremental run; round 2 must fire only on a real
  new duplicate. Both need measuring, and the firing RATE needs measuring, not
  assuming — the CORE-06 fallback was believed cheap and made the optimisation
  inert.
- **No silent cap.** Bounding round 2's file count would reintroduce exactly the
  silent divergence this fixes. If a real corpus shows a pathological fan-out,
  that is a decision to take with the user, not a threshold to bury.
- **Node-id churn widens.** Round 2 re-extracts files the run never touched, so
  their node ids change. Consistent with ARCHITECTURE §6 ("a node_id is only
  valid in the index state it was resolved from"), but it enlarges the set that
  churns per run, and `refresh_result_set`'s re-dispatch (SURF-32) lives on that
  invariant.
- **INDEX_VERSION.** Existing indexes carry the old divergence and nothing else
  heals it, so a bump is probably owed — which costs every user a full re-index
  on upgrade. Decide explicitly, with the released-artifact checklist.

## Verify

```
cargo test --no-default-features --lib a_new_same_name_definition_reaches_an_untouched_bare_caller
```

Currently fails. Paste the appendix test back into `src/indexer/pipeline/tests.rs`
next to `deleting_the_duplicate_puts_the_untouched_edge_back` first — it is kept
here rather than in the tree because the repo's `#[ignore]` attribute means
"expensive or needs credentials", never "known broken", and a red test in the
tree breaks the pre-commit hook for every unrelated commit.

## Appendix — the failing test, verbatim

```rust
#[test]
fn a_new_same_name_definition_reaches_an_untouched_bare_caller() {
    // D#24, deferred 2026-09-08 while adding scope-completeness tests for
    // CORE-06, now pinned. A bare call fans out to EVERY same-name candidate, so
    // a rebuild of the final tree carries `b.py:caller -> a.py:helper` AND
    // `b.py:caller -> c.py:helper`. The incremental run that introduced c.py
    // carries only the first, because b.py did not change and its relations are
    // therefore never re-emitted: the post-passes relabel confidence on edges
    // that exist, they do not create the one that should now exist.
    //
    // Independent of `PostPassScope` — the deferred note records it reproducing
    // unchanged with SCOPED_POST_PASS_MAX_FILES forced to 0 (always Global), so
    // it is older than that scope. User-visible as `callgraph`/`impact`
    // under-reporting a caller until the caller's own file is next touched.
    //
    // The sibling test above compares only the edges the incremental index
    // HOLDS, deliberately, so as not to pin this wrong shape as expected. This
    // one asserts the missing edge directly.
    let project_dir = TempDir::new().unwrap();
    let db_dir = TempDir::new().unwrap();
    let src = project_dir.path().join("src");
    fs::create_dir_all(&src).unwrap();
    fs::write(src.join("a.py"), "def helper():\n    pass\n").unwrap();
    fs::write(src.join("b.py"), "def caller():\n    helper()\n").unwrap();

    let db = Database::open(&db_dir.path().join("index.db")).unwrap();
    run_full_index(&db, project_dir.path(), None, None).unwrap();

    let has_edge = |rows: &[(String, String, String, String)], target: &str| -> bool {
        rows.iter()
            .any(|(s, r, t, _)| s == "src/b.py:caller" && r == REL_CALLS && t == target)
    };
    let before = graph_projection_with_confidence(&db);
    assert!(
        has_edge(&before, "src/a.py:helper") && !has_edge(&before, "src/c.py:helper"),
        "precondition: one `helper`, one edge: {before:?}"
    );

    // One run, one file: c.py appears with a second `helper`. a.py and b.py are
    // byte-identical and are never opened by this run.
    fs::write(src.join("c.py"), "def helper():\n    pass\n").unwrap();
    run_incremental_index(&db, project_dir.path(), None, None).unwrap();

    let control_dir = TempDir::new().unwrap();
    let control = Database::open(&control_dir.path().join("index.db")).unwrap();
    run_full_index(&control, project_dir.path(), None, None).unwrap();

    let inc = graph_projection_with_confidence(&db);
    let full = graph_projection_with_confidence(&control);

    // Control on the control: the rebuild really does fan out, so the assertion
    // below is about the incremental path and not about what a bare call means.
    assert!(
        has_edge(&full, "src/a.py:helper") && has_edge(&full, "src/c.py:helper"),
        "control: a rebuild fans the bare call out to both definitions: {full:?}"
    );
    assert!(
        has_edge(&inc, "src/c.py:helper"),
        "a file appearing with a duplicate name must reach the bare-name callers of that \
         name; the incremental index under-reports the caller until b.py is next touched: {inc:?}"
    );
    assert_eq!(
        inc, full,
        "incremental edge set diverged from a rebuild of the same tree"
    );
}
```

## Change log

- rev 1 (2026-09-11): written after reproducing the defect at `cd6941e`. Test
  authored and run; design narrowed to re-extraction; discovery placement
  identified as the open question.
- rev 3 (2026-09-11): implemented and measured. `INDEX_VERSION` 70 -> 71: the
  guard's question ("does this change what gets extracted for source already
  indexed") answers YES, and nothing but the version triggers the rebuild that
  heals an existing index. Cost of that bump: every user takes one full re-index
  on upgrade, which the release CHANGELOG owes a note about.
- rev 2 (2026-09-11): RED re-reproduced at `cfd4aa2`. Discovery answered — the
  caller owns the count snapshot, because `scope_names_from_count_drift` runs
  only in the `Files` branch and its temps are dropped before the caller sees
  them; the bare-name caller set is read off Phase 2e's own `ambiguous` verdict
  rather than re-derived. `index_files` stays unmodified: two calls, not a
  re-entrant one. Risks enumerated for AUTH.
