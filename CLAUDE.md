# CLAUDE.md

## Project Constitution

- **Ownership:** Treat the active checkout, branch, and existing work as
  user-owned task context. Preserve unrelated state. Repository topology changes
  require explicit user intent.
- **Scope:** Deliver the smallest complete change required by the request.
  Analysis and review are read-only unless implementation is requested. Report
  unrelated cleanup and adjacent issues separately.
- **Truth:** Treat current code and canonical project documentation as the source
  of truth. Verify repository facts before relying on assumptions. Record history
  in commits, PRs, issues, and release records rather than current-state docs.
- **Evolution:** Evolve existing code in place. Treat parallel, versioned,
  “new”, “legacy”, or replacement implementations as architectural decisions
  requiring established project precedent or explicit user intent. Remove
  superseded code when its replacement makes it obsolete within the requested
  scope.
- **Design:** Reuse existing modules, interfaces, dependencies, naming, structure,
  and error-handling patterns before introducing new ones. Design for the current
  requirement and established seams, not speculative future use cases.
- **Evidence:** Preserve established behavior unless the request changes it. Do
  not weaken tests, validation, types, or failure visibility to make a change
  pass. Verify changed behavior with the narrowest relevant established check
  before reporting completion.
