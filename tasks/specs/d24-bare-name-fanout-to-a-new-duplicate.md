---
status: draft
revision: 1
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
